const { defaultAgents } = require('../services/ai-agent.registry');
const { Prisma } = require('@prisma/client');
const { registry } = require('../services/ai-tool.registry');
const { getProvider, SafeFallbackProvider } = require('../services/ai-provider.service');
const { resolveAgent } = require('../services/ai-agent-router.service');
const { collectAgentContext } = require('../services/ai-agent-context.service');
const { executeOperation } = require('../services/ai-operation-executor.service');
const { queueMail } = require('../utils/mailHelper');
const { extractTaskCredentials, sealTaskCredentials, openTaskCredentials, hasTaskCredentialKey, publicTaskInput, recordStage, executeNasProvisionTask,executeNasUpdateTask } = require('../services/ai-nas-task-executor.service');
const { loadConversationState, ensureConversationState, resolveFollowUp, saveTurnState, createPendingAction, updatePendingAction } = require('../services/ai-conversation-memory.service');
const { resolveStructuredIntent } = require('../services/ai-intent.service');
const { orchestrateTools } = require('../services/ai-tool-orchestrator.service');
const { resolveModel, logModelUsage } = require('../services/model-resolution.service');
const { TASK_STATES, transitionTaskState, writeAgentComment, writeTaskProgress, requestUserInput, reportTaskFailure, reportTaskCompletion, processWaitingTasks: processWaitingTaskComms } = require('../services/ai-task-communication.service');

const cleanText = (value, max = 10000) => String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
const parseId = value => Number.parseInt(value, 10);
const stripSecrets = value => cleanText(value,5000)
  .replace(/\b(password|passwd|pwd|shared\s*secret|api\s*secret|secret(?:\s*key)?)\s*(?:is|=|:)?\s*["'`]?[^\s,;"'`]+["'`]?/gi,'$1 [removed]')
  .replace(/\busername\s*(?:is|=|:)?\s*[^\s,;]+/gi,'username [removed]');
const inferTaskDetails = (title,description,requestedType) => {
  const source=`${title} ${description}`;
  const requested=cleanText(requestedType||'',80).toUpperCase();
  const taskType=requested&&requested!=='GENERAL'?requested:/\b(nas|radius)\b/i.test(source)?'NAS_PROVISION':/\b(mikrotik|router|ssh|network config)\b/i.test(source)?'NETWORK_CONFIG':/\b(internet|wifi|connection).*(slow|down|issue|problem)|\b(slow|down).*(internet|wifi|connection)\b/i.test(source)?'CUSTOMER_DIAGNOSTIC':'GENERAL';
  const captureIp=label=>source.match(new RegExp(`${label}[^0-9]*(\\d{1,3}(?:\\.\\d{1,3}){3})`,'i'))?.[1]||null;
  const ips=[...source.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map(match=>match[0]);
  const hardwareRequested=/\b(?:hardware|physical device|routeros|mikrotik|router)\b.{0,100}\b(?:configure|update|apply|sync|install|push|change)\b|\b(?:configure|update|apply|sync|install|push|change)\b.{0,100}\b(?:hardware|physical device|routeros|mikrotik|router)\b/i.test(source);
  const transport=/\btelnet\b/i.test(source)?'telnet':/\bssh\b/i.test(source)?'ssh':null;
  const accessPort=Number(source.match(/\b(?:ssh|telnet)\s*port\s*(?:is|=|:)?\s*(\d{1,5})\b/i)?.[1]||0)||null;
  const ports=source.match(/\b(?:nas\s+)?ports?\s*(?:is|=|:)?\s*([^,;]+)/i)?.[1]?.trim()||null;
  const shortname=source.match(/\bshortname\s*(?:is|=|:)?\s*([^,;\s]+)/i)?.[1]||null;
  const community=source.match(/\bcommunity\s*(?:is|=|:)?\s*([^,;\s]+)/i)?.[1]||null;
  const nasDescription=source.match(/\bdescription\s*(?:is|=|:)?\s*["'`]?([^;"'`]+)["'`]?/i)?.[1]?.trim()||null;
  const nasIp=captureIp('nas(?:\\s+server)?(?:\\s+ip)?')||ips[0]||null;
  const routerIp=captureIp('(?:mikrotik|router|device)(?:\\s+(?:address|ip))?')||null;
  return {taskType,nasIp,radiusServerIp:captureIp('radius(?:\\s+server)?(?:\\s+(?:address|ip))?')||(hardwareRequested?ips.find(ip=>ip!==nasIp&&ip!==routerIp):ips[1])||null,routerIp,deviceIp:routerIp||(hardwareRequested?nasIp:null),hardwareRequested,transport,accessPort,ports,shortname,community,description:nasDescription,nasType:/\bmikrotik\b/i.test(source)?'mikrotik':source.match(/\btype\s*(?:is|=|:)?\s*([a-z0-9_-]+)/i)?.[1]||null,isActive:/\binactive|disable(?:d)?\b/i.test(source)?false:/\bactive|enable(?:d)?\b/i.test(source)?true:undefined,notifyEmail:source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]||null};
};
const isAffirmative = value => /^(?:yes|y|yeah|yep|sure|ok|okay|confirm|confirmed|proceed|continue|go ahead|do it|approve it|add new one|create new one|please proceed|huncha|huss|thik cha|haan|ha|ji)[.!\s]*$/i.test(String(value||'').trim());
const isNegative = value => /^(?:no|n|nope|cancel|stop|do not|don't|not now|later|chhaina|hudaina|nahi)[.!\s]*$/i.test(String(value||'').trim());
function findLegacyPendingRequest(previous=[]){const confirmationIndex=previous.findIndex(item=>item.role==='assistant'&&/\b(?:proceed|continue|go ahead|do you want|shall i|confirm)\b/i.test(item.content||''));const messagesAfterConfirmation=confirmationIndex>=0?previous.slice(0,confirmationIndex):[];const isStillPending=confirmationIndex>=0&&messagesAfterConfirmation.every(item=>item.role==='user'?isAffirmative(item.content):/\b(?:not quite sure|say it another way|more detail|didn't understand|could not understand)\b/i.test(item.content||''));return isStillPending?previous.slice(confirmationIndex+1).find(item=>item.role==='user')?.content||null:null;}
function pendingTaskFromMessage(message,agent){
  const raw=cleanText(message,5000);
  if(!/\b(?:create|creating|add|adding|connect|connecting|configure|configuring|provision|provisioning|register|registering|setup|set up|update|updating|edit|change|modify)\b.{0,80}\b(?:nas|radius)\b|\b(?:nas|radius)\b.{0,80}\b(?:create|creating|add|adding|connect|connecting|configure|configuring|provision|provisioning|register|registering|setup|set up|update|updating|edit|change|modify)\b/i.test(raw))return null;
  const isUpdate=/\b(?:update|updating|edit|change|modify)\b.{0,80}\b(?:nas|radius)\b|\b(?:nas|radius)\b.{0,80}\b(?:update|updating|edit|change|modify)\b/i.test(raw);
  const inferred=inferTaskDetails('Network provisioning',raw);
  if(inferred.taskType!=='NAS_PROVISION')return null;
  const credentials=extractTaskCredentials(raw,{});
  const sealedCredentials=sealTaskCredentials(credentials);
  const missingFields=[];
  if(!inferred.nasIp)missingFields.push('NAS IP address');
  if(!isUpdate&&!credentials?.sharedSecret)missingFields.push('NAS shared secret');
  if(isUpdate&&!credentials?.sharedSecret&&!inferred.radiusServerIp&&!inferred.ports&&!inferred.shortname&&!inferred.community&&!inferred.description&&!inferred.nasType&&inferred.isActive===undefined)missingFields.push('the NAS field and new value to update');
  if(inferred.hardwareRequested&&!inferred.radiusServerIp)missingFields.push('Radius server IP address');
  const action=isUpdate?'Update':'Create',taskType=isUpdate?'NAS_UPDATE':'NAS_PROVISION';
  return {kind:'AI_AGENT_TASK',intent:isUpdate?'UPDATE_NAS':'CREATE_NAS',toolName:isUpdate?'updateNas':'createNas',module:'NAS_MANAGEMENT',agentId:agent?.id||null,title:`${action} NAS ${inferred.nasIp||''}`.trim(),description:stripSecrets(raw),taskType,priority:/\bcritical\b/i.test(raw)?'CRITICAL':/\bhigh\b/i.test(raw)?'HIGH':'HIGH',missingFields,input:{...inferred,sealedCredentials,credentialsStored:Boolean(sealedCredentials),secretStrategy:credentials?.sharedSecret?(sealedCredentials?'USER_PROVIDED_ENCRYPTED':'ENCRYPTION_KEY_MISSING'):(isUpdate?'EXISTING_RECORD':'REQUIRED'),sensitiveFieldsRemoved:true},displayArguments:{title:`${action} NAS ${inferred.nasIp||''}`.trim(),ipAddress:inferred.nasIp,radiusServerIp:inferred.radiusServerIp||null,hardwareRequested:inferred.hardwareRequested,secret:'••••••••',description:stripSecrets(raw)},riskLevel:'HIGH',requiresApproval:true};
}
async function prepareNasPendingAction(req,message,agent){
  const pending=pendingTaskFromMessage(message,agent);
  if(!pending||!pending.input.hardwareRequested)return pending;
  const host=pending.input.deviceIp||pending.input.nasIp;
  const stored=host?await req.prisma.oLT.findFirst({where:{ispId:req.ispId,isDeleted:false,OR:[{ipAddress:host},{sshHost:host}]}}):null;
  const supplied=openTaskCredentials(pending.input.sealedCredentials)||{};
  const transport=pending.input.transport||stored?.defaultTransport?.toLowerCase()||'ssh';
  const username=supplied.username||stored?.sshUsername||null;
  const password=supplied.password||stored?.sshPassword||null;
  if(!username||!password)pending.missingFields.push(`hardware access username and password for ${host||'the NAS device'}`);
  else {
    const sealedCredentials=sealTaskCredentials({...supplied,username,password});
    pending.input={...pending.input,sealedCredentials,credentialsStored:Boolean(sealedCredentials),transport,accessPort:pending.input.accessPort||(transport==='telnet'?stored?.telnetPort:stored?.sshPort)||null,hardwareDeviceId:stored?.id||null,hardwareDeviceName:stored?.name||null};
    pending.displayArguments={...pending.displayArguments,transport,hardwareDevice:stored?.name||host};
  }
  return pending;
}
const publicPendingAction = action => action?{...action,input:publicTaskInput(action.input)}:null;

async function createConfirmedTask(req,pending){
  if(pending.input?.secretStrategy==='ENCRYPTION_KEY_MISSING'||(pending.input?.secretStrategy==='REQUIRED'&&!hasTaskCredentialKey()&&pending.input?.credentialsStored===false)){
    const error=new Error('Secure AI task storage is not configured. Set AI_TASK_CREDENTIAL_KEY (or use the existing ACCESS_SECRET), restart the backend, and submit the NAS request again.');
    error.status=503;
    throw error;
  }
  const agent=await req.prisma.aiAgent.findFirst({where:{id:Number(pending.agentId),ispId:req.ispId,status:'ACTIVE'}});
  if(!agent)throw new Error('The assigned specialist is not active right now. Please activate it and try again.');
  const result=await req.prisma.$transaction(async tx=>{
    const task=await tx.aiAgentTask.create({data:{ispId:req.ispId,agentId:agent.id,requestedBy:req.user.id,title:cleanText(pending.title,191),description:cleanText(pending.description,5000),taskType:pending.taskType,priority:pending.priority,status:'WAITING_APPROVAL',input:pending.input}});
    const action=await tx.aiAgentAction.create({data:{taskId:task.id,agentId:agent.id,actionType:pending.taskType,targetModule:'Network Automation',targetResource:cleanText(pending.input?.nasIp||'',160)||null,input:pending.input,riskLevel:'HIGH',approvalRequired:true,approvalStatus:'PENDING'}});
    const approval=await tx.aiAgentApproval.create({data:{ispId:req.ispId,agentId:agent.id,taskId:task.id,actionId:action.id,requestedBy:req.user.id,approvalType:pending.taskType,status:'PENDING',reason:`Confirmed in AI Chat. NAS ${pending.taskType==='NAS_UPDATE'?'update':'creation'} and Radius synchronization require staff approval${pending.input?.hardwareRequested?', including the requested hardware configuration.':'.'}`}});
    await tx.aiAgentActivityLog.create({data:{ispId:req.ispId,agentId:agent.id,userId:req.user.id,eventType:'TASK_CREATED',description:`${task.title} confirmed in chat`,metadata:{taskId:task.id,approvalId:approval.id,conversationId:Number(req.params.id),stage:'DETECT'}}});
    return {task,approval,agent};
  });
  return result;
}
const agentSlugForOperation = operation => {
  const name = String(operation?.operation || '');
  if (/invoice|billing|payment|proration|credit/i.test(name)) return 'billing';
  if (/ticket|support|complaint/i.test(name)) return 'support';
  if (/tr069|wifi|ssid|nas|olt|splitter|network|device/i.test(name)) return 'noc';
  if (/lead|sales|prospect/i.test(name)) return 'sales';
  if (/service|integration/i.test(name)) return 'manager';
  if (/customer/i.test(name)) return 'support';
  return 'manager';
};

async function writeActivity(req, agentId, eventType, description, metadata = {}) {
  return req.prisma.aiAgentActivityLog.create({
    data: { ispId: req.ispId, agentId, userId: req.user.id, eventType, description, metadata }
  });
}

async function ensureDefaultAgents(req) {
  await req.prisma.$transaction(async tx => {
    for (const definition of defaultAgents) {
      const existing = await tx.aiAgent.findFirst({ where: { ispId: req.ispId, slug: definition.slug } });
      if (existing) {
        const existingPermissions = await tx.aiAgentPermission.findMany({ where: { agentId: existing.id }, select: { module: true } });
        const existingModules = new Set(existingPermissions.map(item => item.module));
        const missingModules = definition.modules.filter(module => !existingModules.has(module));
        if (missingModules.length) {
          await tx.aiAgentPermission.createMany({
            data: missingModules.map(module => ({ agentId: existing.id, module, canRead: true }))
          });
        }
        await tx.aiAgentTool.createMany({
          data: definition.tools.filter(key => registry[key]).map(key => ({
            agentId: existing.id,
            toolKey: key,
            toolName: registry[key].name,
            description: registry[key].description,
            requiresApproval: registry[key].requiresApproval,
            riskLevel: registry[key].riskLevel,
            enabled: true
          })),
          skipDuplicates: true
        });
        continue;
      }
      const agent = await tx.aiAgent.create({
        data: {
          ispId: req.ispId, name: definition.name, slug: definition.slug, role: definition.role,
          department: definition.department, description: definition.description, status: 'ACTIVE',
          isDefault: true, isPublished: true, createdBy: req.user.id,
          instructions: `Stay within ${definition.department}. Never fabricate records. Cite internal record IDs. Require approval for sensitive actions.`,
          systemPrompt: `You are ${definition.name}, ${definition.role}. ISP isolation and least privilege are mandatory.`
        }
      });
      await tx.aiAgentPermission.createMany({ data: definition.modules.map(module => ({ agentId: agent.id, module, canRead: true })) });
      await tx.aiAgentTool.createMany({ data: definition.tools.filter(key => registry[key]).map(key => ({ agentId: agent.id, toolKey: key, toolName: registry[key].name, description: registry[key].description, requiresApproval: registry[key].requiresApproval, riskLevel: registry[key].riskLevel })) });
      await tx.aiAgentVersion.create({ data: { agentId: agent.id, version: 1, instructions: agent.instructions, systemPrompt: agent.systemPrompt, tools: definition.tools, permissions: definition.modules, publishedBy: req.user.id, publishedAt: new Date() } });
    }
  });
}

async function listAgents(req,res,next){try{await ensureDefaultAgents(req);const agents=await req.prisma.aiAgent.findMany({where:{ispId:req.ispId},orderBy:{name:'asc'}});const data=await Promise.all(agents.map(async agent=>{const [permissions,tools,tasks,conversations,approvals]=await Promise.all([req.prisma.aiAgentPermission.findMany({where:{agentId:agent.id}}),req.prisma.aiAgentTool.findMany({where:{agentId:agent.id}}),req.prisma.aiAgentTask.count({where:{agentId:agent.id}}),req.prisma.aiAgentConversation.count({where:{agentId:agent.id}}),req.prisma.aiAgentApproval.count({where:{agentId:agent.id,status:'PENDING'}})]);return {...agent,permissions,tools,_count:{tasks,conversations,approvals}};}));return res.json({success:true,data});}catch(error){return next(error);}}
async function createAgent(req, res, next) { try { const name=cleanText(req.body.name,160);const slug=cleanText(req.body.slug||name.toLowerCase().replace(/[^a-z0-9]+/g,'-'),160);if(!name||!slug)return res.status(400).json({error:'Name and slug are required'});const requestedTools=Array.isArray(req.body.tools)?req.body.tools:[];const requestedPermissions=Array.isArray(req.body.permissions)?req.body.permissions:[];const data=await req.prisma.$transaction(async tx=>{const agent=await tx.aiAgent.create({data:{ispId:req.ispId,name,slug,role:cleanText(req.body.role,160),department:cleanText(req.body.department,160),description:cleanText(req.body.description,5000),instructions:cleanText(req.body.instructions),systemPrompt:cleanText(req.body.systemPrompt),status:'DRAFT',createdBy:req.user.id}});if(requestedPermissions.length)await tx.aiAgentPermission.createMany({data:requestedPermissions.map(item=>typeof item==='string'?{agentId:agent.id,module:cleanText(item,120),canRead:true}:{agentId:agent.id,module:cleanText(item.module,120),canRead:item.canRead!==false,canCreate:Boolean(item.canCreate),canUpdate:Boolean(item.canUpdate),canDelete:Boolean(item.canDelete),canExecute:Boolean(item.canExecute),requiresApproval:Boolean(item.requiresApproval)}).filter(item=>item.module)});for(const item of requestedTools){const key=cleanText(typeof item==='string'?item:item.toolKey,120);const definition=registry[key];const custom=typeof item==='object'&&item.custom===true&&key.startsWith('custom_');if(!definition&&!custom)continue;await tx.aiAgentTool.create({data:{agentId:agent.id,toolKey:key,toolName:cleanText(definition?.name||item.toolName||key,160),description:cleanText(definition?.description||item.description,2000),configuration:custom?{kind:'DECLARATIVE',purpose:cleanText(item.purpose||item.description,2000),inputFields:Array.isArray(item.inputFields)?item.inputFields.slice(0,25):[]}:null,enabled:item.enabled!==false,requiresApproval:custom?item.requiresApproval!==false:definition.requiresApproval,riskLevel:custom?(['LOW','MEDIUM','HIGH'].includes(item.riskLevel)?item.riskLevel:'HIGH'):definition.riskLevel}});}return agent;});await writeActivity(req,data.id,'AGENT_CREATED',`Created ${data.name}`,{tools:requestedTools.length,permissions:requestedPermissions.length});return res.status(201).json({success:true,message:'AI Agent created with its role, prompt, permissions, and functions',data});} catch(error){return next(error);} }
async function listToolCatalog(req,res,next){try{return res.json({success:true,data:Object.entries(registry).map(([toolKey,item])=>({toolKey,name:item.name,description:item.description,requiredPermissions:item.requiredPermissions,riskLevel:item.riskLevel,requiresApproval:item.requiresApproval,inputSchema:item.inputSchema}))});}catch(error){return next(error);}}
async function getAgent(req,res,next){try{await ensureDefaultAgents(req);const id=parseId(req.params.id);const agent=await req.prisma.aiAgent.findFirst({where:{id,ispId:req.ispId}});if(!agent)return res.status(404).json({error:'AI Agent not found'});const [permissions,tools,knowledge,versions]=await Promise.all([req.prisma.aiAgentPermission.findMany({where:{agentId:id}}),req.prisma.aiAgentTool.findMany({where:{agentId:id}}),req.prisma.aiAgentKnowledgeSource.findMany({where:{agentId:id}}),req.prisma.aiAgentVersion.findMany({where:{agentId:id},orderBy:{version:'desc'}})]);return res.json({success:true,data:{...agent,permissions,tools,knowledge,versions}});}catch(error){return next(error);}}
async function updateAgent(req,res,next){try{const id=parseId(req.params.id);const existing=await req.prisma.aiAgent.findFirst({where:{id,ispId:req.ispId}});if(!existing)return res.status(404).json({error:'AI Agent not found'});const allowed=['name','role','department','description','instructions','systemPrompt','status','modelProvider','modelName','temperature','maxTokens','language','isPublished','isDefault'];const update={};for(const key of allowed)if(req.body[key]!==undefined)update[key]=typeof req.body[key]==='string'?cleanText(req.body[key]):req.body[key];const data=await req.prisma.aiAgent.update({where:{id},data:update});await writeActivity(req,id,'AGENT_UPDATED',`Updated ${data.name}`,{fields:Object.keys(update)});return res.json({success:true,message:'AI Agent updated successfully',data});}catch(error){return next(error);}}
async function cloneAgent(req,res,next){try{const source=await req.prisma.aiAgent.findFirst({where:{id:parseId(req.params.id),ispId:req.ispId}});if(!source)return res.status(404).json({error:'AI Agent not found'});const {id,createdAt,updatedAt,...copy}=source;const data=await req.prisma.aiAgent.create({data:{...copy,name:`${source.name} Copy`,slug:`${source.slug}-copy-${Date.now()}`,isDefault:false,isPublished:false,status:'DRAFT',createdBy:req.user.id}});return res.status(201).json({success:true,data});}catch(error){return next(error);}}
const changeAgentState = state => async (req,res,next) => { try { const id=parseId(req.params.id);const existing=await req.prisma.aiAgent.findFirst({where:{id,ispId:req.ispId}});if(!existing)return res.status(404).json({error:'AI Agent not found'});const update=state==='PUBLISHED'?{isPublished:true,status:'ACTIVE'}:{status:state};const data=await req.prisma.aiAgent.update({where:{id},data:update});await writeActivity(req,id,`AGENT_${state}`,`${data.name} changed to ${state}`);return res.json({success:true,data});} catch(error){return next(error);} };
async function getAgentTools(req,res,next){try{const agent=await req.prisma.aiAgent.findFirst({where:{id:parseId(req.params.id),ispId:req.ispId},select:{id:true}});if(!agent)return res.status(404).json({error:'AI Agent not found'});return res.json({success:true,data:await req.prisma.aiAgentTool.findMany({where:{agentId:agent.id}})});}catch(error){return next(error);}}
async function updateAgentTools(req,res,next){try{const id=parseId(req.params.id);const agent=await req.prisma.aiAgent.findFirst({where:{id,ispId:req.ispId}});if(!agent)return res.status(404).json({error:'AI Agent not found'});await req.prisma.$transaction(async tx=>{for(const item of req.body.tools||[]){const key=cleanText(item.toolKey,120);const definition=registry[key];const custom=item.custom===true&&key.startsWith('custom_');if(!definition&&!custom)continue;await tx.aiAgentTool.upsert({where:{agentId_toolKey:{agentId:id,toolKey:key}},update:{enabled:Boolean(item.enabled),description:cleanText(definition?.description||item.description,2000),configuration:custom?{kind:'DECLARATIVE',purpose:cleanText(item.purpose||item.description,2000)}:undefined,requiresApproval:custom?item.requiresApproval!==false:definition.requiresApproval,riskLevel:custom?(['LOW','MEDIUM','HIGH'].includes(item.riskLevel)?item.riskLevel:'HIGH'):definition.riskLevel},create:{agentId:id,toolKey:key,toolName:cleanText(definition?.name||item.toolName||key,160),description:cleanText(definition?.description||item.description,2000),configuration:custom?{kind:'DECLARATIVE',purpose:cleanText(item.purpose||item.description,2000)}:null,enabled:Boolean(item.enabled),requiresApproval:custom?item.requiresApproval!==false:definition.requiresApproval,riskLevel:custom?(['LOW','MEDIUM','HIGH'].includes(item.riskLevel)?item.riskLevel:'HIGH'):definition.riskLevel}});}});return getAgentTools(req,res,next);}catch(error){return next(error);}}
async function getAgentPermissions(req,res,next){try{const agent=await req.prisma.aiAgent.findFirst({where:{id:parseId(req.params.id),ispId:req.ispId},select:{id:true}});if(!agent)return res.status(404).json({error:'AI Agent not found'});return res.json({success:true,data:await req.prisma.aiAgentPermission.findMany({where:{agentId:agent.id}})});}catch(error){return next(error);}}
async function updateAgentPermissions(req,res,next){try{const id=parseId(req.params.id);const agent=await req.prisma.aiAgent.findFirst({where:{id,ispId:req.ispId},select:{id:true}});if(!agent)return res.status(404).json({error:'AI Agent not found'});const permissions=(Array.isArray(req.body.permissions)?req.body.permissions:[]).map(item=>typeof item==='string'?{module:cleanText(item,120),canRead:true}:{module:cleanText(item.module,120),canRead:item.canRead!==false,canCreate:Boolean(item.canCreate),canUpdate:Boolean(item.canUpdate),canDelete:Boolean(item.canDelete),canExecute:Boolean(item.canExecute),requiresApproval:Boolean(item.requiresApproval)}).filter(item=>item.module);await req.prisma.$transaction(async tx=>{await tx.aiAgentPermission.deleteMany({where:{agentId:id}});if(permissions.length)await tx.aiAgentPermission.createMany({data:permissions.map(item=>({...item,agentId:id}))});});return getAgentPermissions(req,res,next);}catch(error){return next(error);}}
async function listTasks(req,res,next){try{const rows=await req.prisma.aiAgentTask.findMany({where:{ispId:req.ispId},orderBy:{createdAt:'desc'},take:100});const data=await Promise.all(rows.map(async task=>{const [agent,approval,action,logs]=await Promise.all([req.prisma.aiAgent.findFirst({where:{id:task.agentId,ispId:req.ispId},select:{id:true,name:true,role:true,department:true,status:true}}),req.prisma.aiAgentApproval.findFirst({where:{taskId:task.id,ispId:req.ispId},orderBy:{createdAt:'desc'}}),req.prisma.aiAgentAction.findFirst({where:{taskId:task.id,agentId:task.agentId},orderBy:{createdAt:'desc'}}),req.prisma.aiAgentActivityLog.findMany({where:{ispId:req.ispId,agentId:task.agentId,eventType:{startsWith:'TASK_'}},orderBy:{createdAt:'asc'},take:100})]);return {...task,input:publicTaskInput(task.input),agent,approval,action:action?{...action,input:publicTaskInput(action.input)}:null,logs:logs.filter(item=>Number(item.metadata?.taskId)===Number(task.id))};}));return res.json({success:true,data});}catch(error){return next(error);}}
async function finalizeTaskLinks({prisma,ispId,task,status,summary}){
  const ticketId=Number(task.input?.ticketId||0);
  if(ticketId)await prisma.ticket.updateMany({where:{id:ticketId,ispId,isDeleted:false},data:{status:status==='COMPLETED'?'RESOLVED':'OPEN',updatedAt:new Date(),...(status==='COMPLETED'?{resolution:cleanText(summary,5000),resolvedAt:new Date()}:{} )}});
  if(status==='COMPLETED'&&task.input?.notifyEmail)queueMail(ispId,{to:task.input.notifyEmail,subject:`Completed: ${task.title}`,text:`Hello,\n\n${summary}\n\nTask: ${task.title}\nStatus: Completed`,html:`<p>Hello,</p><p>${cleanText(summary,2000).replace(/[<>&]/g,'')}</p><p><strong>Task:</strong> ${cleanText(task.title,191).replace(/[<>&]/g,'')}<br><strong>Status:</strong> Completed</p>`});
}
async function runQueuedTask({prisma,ispId,user,agent,task}){
  const claim=await prisma.aiAgentTask.updateMany({where:{id:task.id,ispId,status:'PENDING'},data:{status:'IN_PROGRESS',startedAt:new Date(),completedAt:null,error:null}});
  if(!claim.count)return;
  await prisma.aiPendingAgentAction.updateMany({where:{taskId:task.id,ispId,status:{in:['AWAITING_APPROVAL','APPROVED','FAILED']}},data:{status:'EXECUTING',error:null}}).catch(()=>{});

  // Resolve the consistent model for this task
  const modelResolution = await resolveModel({ prisma, ispId, agent, task, context: 'task' });
  const ticketId = Number(task.input?.ticketId) || null;

  // Write initial progress comment
  if (ticketId) {
    await writeAgentComment(prisma, {
      ticketId, agentId: agent.id, ispId,
      content: `I am now working on this task. Using ${modelResolution.provider}/${modelResolution.model} (source: ${modelResolution.source}).`,
      commentType: 'PROGRESS'
    });
  }

  try{
    const current=await prisma.aiAgentTask.findFirst({where:{id:task.id,ispId}})||task;

    // Write analyzing stage
    await writeTaskProgress(prisma, {
      taskId: current.id, agentId: agent.id, ispId,
      userId: user?.id || current.requestedBy,
      stage: 'ANALYZING',
      description: `Analyzing task: ${current.title}`
    });

    if(current.taskType==='NAS_PROVISION'){
      if (ticketId) await writeAgentComment(prisma, { ticketId, agentId: agent.id, ispId, content: 'Starting NAS provisioning workflow...', commentType: 'PROGRESS' });
      const execution=await executeNasProvisionTask({prisma,ispId,user,agent,task:current});
      await prisma.aiAgentTask.update({where:{id:current.id},data:{status:'COMPLETED',output:execution,error:null,completedAt:new Date()}});
      await prisma.aiPendingAgentAction.updateMany({where:{taskId:current.id,ispId},data:{status:'COMPLETED',error:null}}).catch(()=>{});
      await prisma.aiAgentAction.updateMany({where:{taskId:current.id,agentId:agent.id},data:{output:{verified:execution.verified,nas:execution.nas,radius:execution.radius,router:execution.router},executedAt:new Date()}});
      await reportTaskCompletion(prisma, { taskId: current.id, ispId, agentId: agent.id, userId: user?.id || current.requestedBy, summary: execution.summary, result: execution, ticketId });
      await finalizeTaskLinks({prisma,ispId,task:current,status:'COMPLETED',summary:execution.summary});
      return;
    }
    if(current.taskType==='NAS_UPDATE'){
      if (ticketId) await writeAgentComment(prisma, { ticketId, agentId: agent.id, ispId, content: 'Starting NAS update workflow...', commentType: 'PROGRESS' });
      const execution=await executeNasUpdateTask({prisma,ispId,user,agent,task:current});
      await prisma.aiAgentTask.update({where:{id:current.id},data:{status:'COMPLETED',output:execution,error:null,completedAt:new Date()}});
      await prisma.aiPendingAgentAction.updateMany({where:{taskId:current.id,ispId},data:{status:'COMPLETED',error:null}}).catch(()=>{});
      await prisma.aiAgentAction.updateMany({where:{taskId:current.id,agentId:agent.id},data:{output:{verified:execution.verified,nas:execution.nas,radius:execution.radius,router:execution.router},executedAt:new Date()}});
      await reportTaskCompletion(prisma, { taskId: current.id, ispId, agentId: agent.id, userId: user?.id || current.requestedBy, summary: execution.summary, result: execution, ticketId });
      return;
    }
    await recordStage(prisma,{ispId,agentId:agent.id,userId:user?.id||current.requestedBy,taskId:current.id,stage:'ANALYZE',description:'The assigned specialist is analyzing the request and available records.'});

    // Check if user provided replies for previously waiting tasks
    const userReplies = current.input?.userReplies || [];
    const taskDescription = userReplies.length > 0
      ? `${current.title}. ${current.description || ''}\n\nAdditional context from user:\n${userReplies.map(r => r.content).join('\n')}`
      : `${current.title}. ${current.description || ''}`;

    let operation=null;if(current.taskType==='CUSTOMER_DIAGNOSTIC')operation=await executeOperation({prisma,ispId,user,message:taskDescription,contextMessage:taskDescription});
    const [runtimeTools,runtimePermissions,runtimeKnowledge]=await Promise.all([prisma.aiAgentTool.findMany({where:{agentId:agent.id,enabled:true}}),prisma.aiAgentPermission.findMany({where:{agentId:agent.id}}),prisma.aiAgentKnowledgeSource.findMany({where:{agentId:agent.id,enabled:true}})]);
    const provider=await getProvider({prisma,ispId});const context={kind:operation?'RECORDS':'TASK',records:{task:{id:current.id,title:current.title,description:current.description,taskType:current.taskType,userReplies},...(operation?{operation}:{})},performed:operation?.performed||[]};

    if (ticketId) await writeAgentComment(prisma, { ticketId, agentId: agent.id, ispId, content: 'Executing task with AI model...', commentType: 'PROGRESS' });

    const result=await provider.complete({agent,message:`Complete this assigned task and report the verified outcome: ${taskDescription}`,context,history:[],user,runtime:{tools:runtimeTools,permissions:runtimePermissions,knowledge:runtimeKnowledge}});

    // Check if the AI response indicates it needs more information
    const needsMoreInfo = /\b(need|require|missing|please provide|cannot proceed|don't have|do not have)\b.*\b(information|details|credentials|password|ip address|access|input)\b/i.test(result.content);

    if (needsMoreInfo && result.provider !== 'safe-fallback') {
      // AI agent is asking for more information — enter WAITING_FOR_USER
      await requestUserInput(prisma, {
        taskId: current.id,
        ispId,
        agentId: agent.id,
        userId: user?.id || current.requestedBy,
        question: result.content,
        ticketId
      });
      await logModelUsage(prisma, { ispId, agentId: agent.id, userId: user?.id, resolution: modelResolution, usage: result.usage, context: 'task' });
      return;
    }

    if(result.provider==='safe-fallback'&&!operation){
      // Report the failure with a suggestion instead of just throwing
      await reportTaskFailure(prisma, {
        taskId: current.id, ispId, agentId: agent.id,
        userId: user?.id || current.requestedBy,
        error: 'No configured AI model or allowlisted executor supports this task type yet.',
        suggestion: 'Configure a Gemini or OpenAI API key in System Settings → AI Provider, or assign this task to a human operator.',
        ticketId
      });
      throw Object.assign(new Error('I could not start this safely because no configured model or allowlisted executor supports this task yet.'),{code:'AI_TASK_BLOCKED'});
    }
    const summary=result.content;
    await prisma.aiAgentTask.update({where:{id:current.id},data:{status:'COMPLETED',output:{stage:'REPORT',summary,provider:result.provider,model:result.model,modelResolution,operation:operation||null,verified:Boolean(operation)},completedAt:new Date()}});
    await prisma.aiPendingAgentAction.updateMany({where:{taskId:current.id,ispId},data:{status:'COMPLETED',error:null}}).catch(()=>{});
    await reportTaskCompletion(prisma, { taskId: current.id, ispId, agentId: agent.id, userId: user?.id || current.requestedBy, summary, result: { provider: result.provider, model: result.model }, ticketId });
    await finalizeTaskLinks({prisma,ispId,task:current,status:'COMPLETED',summary});
    await logModelUsage(prisma, { ispId, agentId: agent.id, userId: user?.id, resolution: modelResolution, usage: result.usage, context: 'task' });
  }catch(error){
    console.error('[AI task runner failed]',error);
    const status=error.code==='AI_TASK_BLOCKED'?'BLOCKED':'FAILED';const message=cleanText(error.message||'The task could not be completed.',5000);
    await prisma.aiAgentTask.updateMany({where:{id:task.id,ispId},data:{status,error:message,output:{stage:status==='BLOCKED'?'APPROVE':'REPORT',summary:message,partialResult:error.partialResult||null},completedAt:new Date()}}).catch(()=>{});
    await prisma.aiPendingAgentAction.updateMany({where:{taskId:task.id,ispId},data:{status:'FAILED',error:message}}).catch(()=>{});
    // Report failure to ticket with human-readable error
    await reportTaskFailure(prisma, {
      taskId: task.id, ispId, agentId: agent.id,
      userId: user?.id || task.requestedBy,
      error: message,
      suggestion: status === 'BLOCKED' ? 'Configure an AI provider or approve this task for manual execution.' : 'Check the error details and retry, or assign to a human operator.',
      ticketId
    }).catch(() => {});
    await finalizeTaskLinks({prisma,ispId,task,status,summary:message}).catch(()=>{});
  }
}
async function createTask(req,res,next){
  try{
    const agent=await req.prisma.aiAgent.findFirst({where:{id:parseId(req.params.id),ispId:req.ispId,status:'ACTIVE'}});
    if(!agent)return res.status(404).json({error:'Active AI Agent not found'});
    const requestedTicketId=req.body.ticketId?parseId(req.body.ticketId):0;
    let linkedTicket=requestedTicketId?await req.prisma.ticket.findFirst({where:{id:requestedTicketId,ispId:req.ispId,isDeleted:false}}):null;
    if(requestedTicketId&&!linkedTicket)return res.status(404).json({error:'Support ticket not found'});
    const title=cleanText(req.body.title||linkedTicket?.title,191);
    if(!title)return res.status(400).json({error:'Task title is required'});
    const rawDescription=cleanText(req.body.description||linkedTicket?.description,5000);
    const description=stripSecrets(rawDescription);
    const inferred=inferTaskDetails(title,rawDescription,req.body.taskType);
    const taskType=inferred.taskType;
    const priority=['LOW','MEDIUM','HIGH','CRITICAL'].includes(String(req.body.priority||linkedTicket?.priority).toUpperCase())?String(req.body.priority||linkedTicket?.priority).toUpperCase():'MEDIUM';
    const rawInput=req.body.input&&typeof req.body.input==='object'?req.body.input:{};
    const {password,secret,sharedSecret,apiSecret,...safeInput}=rawInput;
    const sensitive=/NAS|RADIUS|MIKROTIK|ROUTER|SSH|CONFIG|PROVISION|HARDWARE/.test(taskType);
    const rawCredentialRef=cleanText(rawInput.credentialRef,191);
    const unsafeCredentialRef=/\b(user(?:name)?|password|passwd|pwd|secret|admin)\b|@@/i.test(rawCredentialRef);
    const taskCredentials=extractTaskCredentials(rawDescription,rawInput);
    const sealedCredentials=sealTaskCredentials(taskCredentials);
    const input={...safeInput,...inferred,credentialRef:unsafeCredentialRef?null:(rawCredentialRef||null),sealedCredentials,secretStrategy:'GENERATE_ON_EXECUTION',sensitiveFieldsRemoved:Boolean(password||secret||sharedSecret||apiSecret||unsafeCredentialRef||description!==rawDescription),credentialsStored:Boolean(sealedCredentials)};
    delete input.username;delete input.passwd;delete input.pwd;
    if(req.body.createTicket){
      const count=await req.prisma.ticket.count({where:{ispId:req.ispId}});
      linkedTicket=await req.prisma.ticket.create({data:{ticketNumber:`AI-${Date.now()}-${count+1}`,title,description,status:'OPEN',priority,category:'AI_OPERATIONS',ispId:req.ispId,branchId:req.user.selectedBranchId||req.user.branchId||null,createdById:req.user.id,updatedAt:new Date()}});
      input.ticketId=linkedTicket.id;
      input.ticketNumber=linkedTicket.ticketNumber;
    }else if(linkedTicket){input.ticketId=linkedTicket.id;input.ticketNumber=linkedTicket.ticketNumber;}
    const result=await req.prisma.$transaction(async tx=>{
      const task=await tx.aiAgentTask.create({data:{ispId:req.ispId,agentId:agent.id,requestedBy:req.user.id,title,description,taskType,priority,status:sensitive?'WAITING_APPROVAL':'PENDING',input}});
      let approval=null;
      if(sensitive){
        const action=await tx.aiAgentAction.create({data:{taskId:task.id,agentId:agent.id,actionType:taskType,targetModule:cleanText(input.targetModule||'Network Automation',120),targetResource:cleanText(input.targetResource||input.nasIp||input.routerIp||'',160)||null,input,riskLevel:'HIGH',approvalRequired:true,approvalStatus:'PENDING'}});
        approval=await tx.aiAgentApproval.create({data:{ispId:req.ispId,agentId:agent.id,taskId:task.id,actionId:action.id,requestedBy:req.user.id,approvalType:taskType,status:'PENDING',reason:'Live network or credential-backed change requires approval.'}});
      }
      if(input.ticketId)await tx.ticket.updateMany({where:{id:Number(input.ticketId),ispId:req.ispId,isDeleted:false},data:{status:'IN_PROGRESS',updatedAt:new Date(),...(description!==rawDescription?{description}:{} )}});
      return {task,approval};
    });
    await writeActivity(req,agent.id,'TASK_CREATED',title,{taskId:result.task.id,ticketId:input.ticketId||null,approvalId:result.approval?.id||null});
    if(!sensitive)setImmediate(()=>runQueuedTask({prisma:req.prisma,ispId:req.ispId,user:req.user,agent,task:result.task}));
    return res.status(201).json({success:true,message:result.approval?`${agent.name} has the task. Once approved, the worker will start it automatically and show each step here.`:`${agent.name} has started processing the task.`,data:{...result.task,input:publicTaskInput(result.task.input),agent:{id:agent.id,name:agent.name,slug:agent.slug,role:agent.role},ticket:linkedTicket,approval:result.approval}});
  }catch(error){return next(error);}
}

async function updateTaskStatus(req,res,next){
  try{
    const task=await req.prisma.aiAgentTask.findFirst({where:{id:parseId(req.params.taskId),ispId:req.ispId}});
    if(!task)return res.status(404).json({error:'AI task not found'});
    const status=String(req.body.status||'').toUpperCase();
    if(!['PENDING','IN_PROGRESS','WAITING_APPROVAL','BLOCKED','COMPLETED','FAILED','CANCELLED'].includes(status))return res.status(400).json({error:'Invalid task status'});
    const sensitive=/NAS|RADIUS|MIKROTIK|ROUTER|SSH|CONFIG|PROVISION|HARDWARE/.test(task.taskType);
    const nextStatus=status==='IN_PROGRESS'&&sensitive?'PENDING':status;
    const data=await req.prisma.aiAgentTask.update({where:{id:task.id},data:{status:nextStatus,output:req.body.output||task.output,error:status==='FAILED'?cleanText(req.body.error,5000):null,...(status==='IN_PROGRESS'?{startedAt:null,completedAt:null,error:null}:{}),...(['COMPLETED','FAILED','CANCELLED'].includes(status)?{completedAt:new Date()}:{} )}});
    const ticketId=Number(task.input?.ticketId||0);
    if(ticketId){
      const ticketStatus=status==='COMPLETED'?'RESOLVED':status==='FAILED'?'OPEN':'IN_PROGRESS';
      await req.prisma.ticket.updateMany({where:{id:ticketId,ispId:req.ispId,isDeleted:false},data:{status:ticketStatus,updatedAt:new Date(),...(status==='COMPLETED'?{resolution:cleanText(req.body.resolution||req.body.output?.summary||`${data.title} completed by the assigned AI agent.`,5000),resolvedAt:new Date()}:{} )}});
    }
    let notification=null;
    if(status==='COMPLETED'&&task.input?.notifyEmail){
      notification=queueMail(req.ispId,{to:task.input.notifyEmail,subject:`Completed: ${data.title}`,text:`The assigned AI work item has been completed.\n\nTask: ${data.title}\nStatus: Completed\n${cleanText(req.body.resolution||req.body.output?.summary||'',2000)}`,html:`<p>The assigned AI work item has been completed.</p><p><strong>Task:</strong> ${data.title.replace(/[<>&]/g,'')}</p><p><strong>Status:</strong> Completed</p>`});
    }
    await writeActivity(req,task.agentId,'TASK_STATUS_CHANGED',`${task.title}: ${status}`,{taskId:task.id,ticketId:ticketId||null});
    if(status==='IN_PROGRESS'){const approval=sensitive?await req.prisma.aiAgentApproval.findFirst({where:{taskId:task.id,ispId:req.ispId,status:'APPROVED'}}):true;if(!approval)return res.status(409).json({error:'This network task still needs approval before it can start.'});const agent=await req.prisma.aiAgent.findFirst({where:{id:task.agentId,ispId:req.ispId,status:'ACTIVE'}});if(agent)setImmediate(()=>runQueuedTask({prisma:req.prisma,ispId:req.ispId,user:req.user,agent,task:{...task,status:'PENDING'}}));}
    return res.json({success:true,data:{...data,notification}});
  }catch(error){return next(error);}
}
async function listApprovals(req,res,next){try{return res.json({success:true,data:await req.prisma.aiAgentApproval.findMany({where:{ispId:req.ispId},orderBy:{createdAt:'desc'},take:100})});}catch(error){return next(error);}}
async function decideApproval(req,res,next){
  try{
    const approved=req.params.decision==='approve';
    const item=await req.prisma.aiAgentApproval.findFirst({where:{id:parseId(req.params.id),ispId:req.ispId,status:'PENDING'}});
    if(!item)return res.status(404).json({error:'This approval was already handled or could not be found.'});
    const data=await req.prisma.$transaction(async tx=>{
      const approval=await tx.aiAgentApproval.update({where:{id:item.id},data:{status:approved?'APPROVED':'REJECTED',assignedTo:req.user.id,reason:cleanText(req.body.reason,2000),...(approved?{approvedAt:new Date()}:{rejectedAt:new Date()})}});
      if(item.actionId)await tx.aiAgentAction.updateMany({where:{id:item.actionId,agentId:item.agentId},data:{approvalStatus:approved?'APPROVED':'REJECTED'}});
      if(item.taskId)await tx.aiAgentTask.updateMany({where:{id:item.taskId,ispId:req.ispId},data:{status:approved?'PENDING':'CANCELLED',startedAt:null,completedAt:approved?null:new Date(),error:approved?null:'Execution approval was rejected.'}});
      await tx.aiAgentActivityLog.create({data:{ispId:req.ispId,agentId:item.agentId,userId:req.user.id,eventType:approved?'APPROVAL_APPROVED':'APPROVAL_REJECTED',description:approved?`Approval ${item.id} granted. The task worker has been notified.`:`Approval ${item.id} was rejected. No live change was made.`,metadata:{approvalId:item.id,taskId:item.taskId,stage:'APPROVE'}}});
      return approval;
    });
    const pendingAction=await req.prisma.aiPendingAgentAction.findFirst({where:{ispId:req.ispId,approvalId:item.id}}).catch(()=>null);
    if(pendingAction)await updatePendingAction(req.prisma,{conversationId:pendingAction.conversationId,actionId:pendingAction.id,status:approved?'APPROVED':'REJECTED',approvalId:item.id,taskId:item.taskId,error:approved?null:'Execution approval was rejected.'});
    if(approved&&item.taskId){
      const [task,agent]=await Promise.all([req.prisma.aiAgentTask.findFirst({where:{id:item.taskId,ispId:req.ispId,status:'PENDING'}}),req.prisma.aiAgent.findFirst({where:{id:item.agentId,ispId:req.ispId,status:'ACTIVE'}})]);
      if(task&&agent)setImmediate(()=>runQueuedTask({prisma:req.prisma,ispId:req.ispId,user:req.user,agent,task}));
    }
    return res.json({success:true,message:approved?'Approved — the assigned specialist is starting now. You can watch each stage and any error in Agent Tasks.':'Understood. The request was rejected and no live change was made.',data});
  }catch(error){return next(error);}
}

let workerBusy=false;
async function processQueuedTasks(prisma){
  if(workerBusy)return;
  workerBusy=true;
  try{
    // Process pending tasks
    const tasks=await prisma.aiAgentTask.findMany({where:{status:'PENDING'},orderBy:{createdAt:'asc'},take:10});
    for(const task of tasks){
      const sensitive=/NAS|RADIUS|MIKROTIK|ROUTER|SSH|CONFIG|PROVISION|HARDWARE/.test(task.taskType);
      if(sensitive){const approval=await prisma.aiAgentApproval.findFirst({where:{taskId:task.id,ispId:task.ispId,status:'APPROVED'}});if(!approval)continue;}
      const [agent,user]=await Promise.all([prisma.aiAgent.findFirst({where:{id:task.agentId,ispId:task.ispId,status:'ACTIVE'}}),prisma.user.findFirst({where:{id:task.requestedBy,ispId:task.ispId,isDeleted:false}})]);
      if(!agent)continue;
      await runQueuedTask({prisma,ispId:task.ispId,user:user||{id:task.requestedBy},agent,task});
    }

    // Process tasks waiting for user input (human-in-the-loop polling)
    const resumedIds = await processWaitingTaskComms(prisma);
    for (const taskId of resumedIds) {
      const resumedTask = await prisma.aiAgentTask.findFirst({ where: { id: taskId, status: 'ANALYZING' } });
      if (!resumedTask) continue;
      const [agent, user] = await Promise.all([
        prisma.aiAgent.findFirst({ where: { id: resumedTask.agentId, ispId: resumedTask.ispId, status: 'ACTIVE' } }),
        prisma.user.findFirst({ where: { id: resumedTask.requestedBy, ispId: resumedTask.ispId, isDeleted: false } })
      ]);
      if (agent) {
        // Re-queue the resumed task as PENDING so it gets picked up
        await prisma.aiAgentTask.update({ where: { id: taskId }, data: { status: 'PENDING' } });
        await runQueuedTask({ prisma, ispId: resumedTask.ispId, user: user || { id: resumedTask.requestedBy }, agent, task: { ...resumedTask, status: 'PENDING' } });
      }
    }
  }catch(error){console.error('[AI task worker]',error);}finally{workerBusy=false;}
}
function startTaskWorker(prisma){
  setTimeout(()=>processQueuedTasks(prisma),1500);
  const timer=setInterval(()=>processQueuedTasks(prisma),5000);
  timer.unref();
  return timer;
}
async function listActivity(req,res,next){try{return res.json({success:true,data:await req.prisma.aiAgentActivityLog.findMany({where:{ispId:req.ispId},orderBy:{createdAt:'desc'},take:req.path.includes('audit')?250:100})});}catch(error){return next(error);}}
async function listUsage(req,res,next){try{return res.json({success:true,data:await req.prisma.aiAgentUsage.findMany({where:{ispId:req.ispId},orderBy:{createdAt:'desc'},take:100})});}catch(error){return next(error);}}
async function getAnalytics(req,res,next){try{await ensureDefaultAgents(req);const where={ispId:req.ispId};const [total,active,tasks,approvals,conversations,usage]=await Promise.all([req.prisma.aiAgent.count({where}),req.prisma.aiAgent.count({where:{...where,status:'ACTIVE'}}),req.prisma.aiAgentTask.groupBy({by:['status'],where,_count:true}),req.prisma.aiAgentApproval.count({where:{...where,status:'PENDING'}}),req.prisma.aiAgentConversation.count({where}),req.prisma.aiAgentUsage.aggregate({where,_sum:{totalTokens:true,estimatedCost:true},_avg:{durationMs:true}})]);return res.json({success:true,data:{total,active,paused:total-active,tasks,approvals,conversations,totalTokens:usage._sum.totalTokens||0,estimatedCost:usage._sum.estimatedCost||0,averageResponseMs:Math.round(usage._avg.durationMs||0)}});}catch(error){return next(error);}}
async function listConversations(req,res,next){try{const rows=await req.prisma.aiAgentConversation.findMany({where:{ispId:req.ispId,userId:req.user.id},orderBy:{lastMessageAt:'desc'}});const data=await Promise.all(rows.map(async row=>({...row,agent:await req.prisma.aiAgent.findFirst({where:{id:row.agentId,ispId:req.ispId},select:{id:true,name:true,slug:true,role:true,department:true,avatar:true,status:true}}),messageCount:await req.prisma.aiAgentMessage.count({where:{conversationId:row.id}})})));return res.json({success:true,data});}catch(error){return next(error);}}
async function routeIntent(req,res,next){try{await ensureDefaultAgents(req);const message=cleanText(req.body.message,5000);if(!message)return res.status(400).json({error:'Message is required'});const {agent,routing}=await resolveAgent(req.prisma,req.ispId,message,req.body.agentId);if(!agent)return res.status(404).json({error:'No active specialist agent is available'});return res.json({success:true,data:{agent,routing,suggestion:`${agent.name} is the best specialist for this request.`}});}catch(error){return next(error);}}
async function createConversation(req,res,next){try{await ensureDefaultAgents(req);const message=cleanText(req.body.message||req.body.title,5000);const {agent,routing}=await resolveAgent(req.prisma,req.ispId,message,req.body.agentId);if(!agent)return res.status(404).json({error:'Active AI Agent not found'});const data=await req.prisma.aiAgentConversation.create({data:{ispId:req.ispId,userId:req.user.id,agentId:agent.id,title:cleanText(req.body.title||message||`Chat with ${agent.name}`,191),summary:routing.score?`Active specialist: ${agent.name}`:'Manager AI listening for the next task'}});return res.status(201).json({success:true,data:{...data,agent,routing}});}catch(error){return next(error);}}
async function getConversation(req,res,next){try{const data=await req.prisma.aiAgentConversation.findFirst({where:{id:parseId(req.params.id),ispId:req.ispId,userId:req.user.id}});if(!data)return res.status(404).json({error:'Conversation not found'});return res.json({success:true,data});}catch(error){return next(error);}}
async function updateConversation(req,res,next){try{const existing=await req.prisma.aiAgentConversation.findFirst({where:{id:parseId(req.params.id),ispId:req.ispId,userId:req.user.id}});if(!existing)return res.status(404).json({error:'Conversation not found'});const update={};for(const key of ['title','status','summary','pinned','archived'])if(req.body[key]!==undefined)update[key]=req.body[key];return res.json({success:true,data:await req.prisma.aiAgentConversation.update({where:{id:existing.id},data:update})});}catch(error){return next(error);}}
function publicChatMessage(message){if(!message)return message;const structured=message.structuredData&&typeof message.structuredData==='object'?{...message.structuredData}:message.structuredData;if(structured?.pendingAction)structured.pendingAction=publicPendingAction(structured.pendingAction);const content=message.role==='user'&&/\b(?:password|passwd|pwd|shared\s*secret|api\s*secret|secret(?:\s*key)?)\b/i.test(message.content||'')?stripSecrets(message.content):message.content;return {...message,content,structuredData:structured};}
async function listMessages(req,res,next){try{const conversation=await req.prisma.aiAgentConversation.findFirst({where:{id:parseId(req.params.id),ispId:req.ispId,userId:req.user.id}});if(!conversation)return res.status(404).json({error:'Conversation not found'});const messages=await req.prisma.aiAgentMessage.findMany({where:{conversationId:conversation.id},orderBy:{createdAt:'asc'}});return res.json({success:true,data:messages.map(publicChatMessage)});}catch(error){return next(error);}}
async function getConversationContext(req,res,next){try{const conversationId=parseId(req.params.id);const conversation=await req.prisma.aiAgentConversation.findFirst({where:{id:conversationId,ispId:req.ispId,userId:req.user.id}});if(!conversation)return res.status(404).json({error:'Conversation not found'});await ensureConversationState(req.prisma,{ispId:req.ispId,conversationId,userId:req.user.id,selectedAgentId:conversation.agentId,chatId:conversationId});const state=await loadConversationState(req.prisma,{ispId:req.ispId,conversationId,userId:req.user.id});const [routes,corrections,toolExecutions]=await Promise.all([req.prisma.aiAgentRoute.findMany({where:{ispId:req.ispId,conversationId},orderBy:{createdAt:'desc'},take:10}),req.prisma.aiConversationCorrection.findMany({where:{ispId:req.ispId,conversationId},orderBy:{createdAt:'desc'},take:10}),req.prisma.aiToolExecution.findMany({where:{ispId:req.ispId,conversationId},orderBy:{createdAt:'desc'},take:10,select:{id:true,toolName:true,status:true,durationMs:true,errorCode:true,errorMessage:true,createdAt:true,completedAt:true}})]);const pending=state.pendingAction?{id:state.pendingAction.id,actionType:state.pendingAction.actionType,toolName:state.pendingAction.toolName,module:state.pendingAction.module,riskLevel:state.pendingAction.riskLevel,displayArguments:state.pendingAction.displayArguments,status:state.pendingAction.status,requiresApproval:state.pendingAction.requiresApproval,approvalId:state.pendingAction.approvalId,taskId:state.pendingAction.taskId,error:state.pendingAction.error,expiresAt:state.pendingAction.expiresAt,confirmationExpiresAt:state.pendingAction.confirmationExpiresAt}:null;return res.json({success:true,data:{...state,pendingAction:pending,routes,corrections,toolExecutions,lastSuccessfulTool:toolExecutions.find(item=>item.status==='COMPLETED')||null}});}catch(error){return next(error);}}
async function sendMessage(req,res,next){
  try{
    const started=Date.now();
    const memoryIdleMs=10*60*1000;
    const conversation=await req.prisma.aiAgentConversation.findFirst({where:{id:parseId(req.params.id),ispId:req.ispId,userId:req.user.id}});
    if(!conversation)return res.status(404).json({error:'Conversation not found'});
    const content=cleanText(String(req.body.content||'').replace(/<[^>]*>/g,''));
    if(!content)return res.status(400).json({error:'Message is required'});
    const memoryExpired=Date.now()-new Date(conversation.lastMessageAt).getTime()>=memoryIdleMs;
    const previous=memoryExpired?[]:await req.prisma.aiAgentMessage.findMany({where:{conversationId:conversation.id},orderBy:{createdAt:'desc'},take:16});
    const lastMessage=previous[0];
    const pendingCarrier=previous.find(item=>item.role==='assistant'&&item.structuredData?.pendingAction);
    let pendingAction=pendingCarrier?.structuredData?.pendingAction||null;
    if(!pendingAction){
      const earlierRequest=findLegacyPendingRequest(previous);
      if(earlierRequest){const pendingAgent=await req.prisma.aiAgent.findFirst({where:{ispId:req.ispId,status:'ACTIVE',slug:'noc'}})||await req.prisma.aiAgent.findFirst({where:{ispId:req.ispId,status:'ACTIVE',id:conversation.agentId}});pendingAction=pendingTaskFromMessage(earlierRequest,pendingAgent);}
    }
    const confirming=Boolean(pendingAction&&isAffirmative(content));
    const declining=Boolean(pendingAction&&isNegative(content));
    const storedContent=/\b(?:password|passwd|pwd|shared\s*secret|api\s*secret|secret(?:\s*key)?)\b/i.test(content)?stripSecrets(content):content;
    const userMessage=await req.prisma.aiAgentMessage.create({data:{conversationId:conversation.id,senderType:'USER',senderId:req.user.id,role:'user',content:storedContent,attachments:Array.isArray(req.body.attachments)?req.body.attachments.slice(0,5):[]}});
    const history=previous.reverse();
    const contextText=[...history.filter(item=>item.role==='user').map(item=>item.content),content].join('\n');
    const operationContextText=[...history.map(item=>`${item.role}: ${item.content}`),`user: ${content}`].join('\n');
    let operation=null;
    let confirmedTask=null;
    if(confirming){confirmedTask=await createConfirmedTask(req,pendingAction);operation={operation:'createAiAgentTask',performed:['createAutomationTask'],data:{task:{...confirmedTask.task,input:publicTaskInput(confirmedTask.task.input)},approval:confirmedTask.approval}};}
    try{
      if(confirming||declining){}else{
      operation=await executeOperation({prisma:req.prisma,ispId:req.ispId,user:req.user,message:content,contextMessage:operationContextText});
      }
    }catch(error){
      console.error('[AI operation failed]', error);
      operation={operation:'operationError',approvalRequired:true,error:'I could not complete that live-record check because the backend operation failed. The error has been logged; please retry after the fix is deployed.'};
    }
    let routed=confirmedTask?{agent:confirmedTask.agent,routing:{slug:confirmedTask.agent.slug,confidence:1,matched:['confirmed pending action'],confirmation:true}}:await resolveAgent(req.prisma,req.ispId,content,req.body.agentId);
    if(operation&&!confirmedTask){
      const operationSlug=agentSlugForOperation(operation);
      const operationAgent=await req.prisma.aiAgent.findFirst({where:{ispId:req.ispId,slug:operationSlug,status:'ACTIVE'}});
      if(operationAgent)routed={agent:operationAgent,routing:{slug:operationSlug,confidence:.98,matched:[operation.operation],operation:true,reason:'operation_intent'}};
    }
    const agent=routed.agent||await req.prisma.aiAgent.findFirst({where:{id:conversation.agentId,ispId:req.ispId,status:'ACTIVE'}});
    if(!agent)return res.status(409).json({error:'Selected AI Agent is not active'});
    const handoff=agent.id!==conversation.agentId;
    const context=await collectAgentContext({prisma:req.prisma,ispId:req.ispId,agent,message:contextText,currentMessage:content,user:req.user});
    if(operation){context.records=context.records||{};context.records.operation=operation;context.performed=[...new Set([...(context.performed||[]),...(operation.performed||[])])];context.kind='RECORDS';}
    const conversationalReply=context.kind==='GREETING'||(context.performed||[]).includes('getSignedInUser')||/\b(how are you|how's it going|thank you|thanks)\b/i.test(content);
    const [runtimeTools,runtimePermissions,runtimeKnowledge]=await Promise.all([
      req.prisma.aiAgentTool.findMany({where:{agentId:agent.id,enabled:true}}),
      req.prisma.aiAgentPermission.findMany({where:{agentId:agent.id}}),
      req.prisma.aiAgentKnowledgeSource.findMany({where:{agentId:agent.id,enabled:true}})
    ]);
    const runtime={tools:runtimeTools,permissions:runtimePermissions,knowledge:runtimeKnowledge};
    const provider=conversationalReply ? new SafeFallbackProvider() : await getProvider({ prisma:req.prisma, ispId:req.ispId });
    const result=confirming?{content:`Absolutely — I created task #${confirmedTask.task.id} for ${confirmedTask.agent.name}. Approval #${confirmedTask.approval.id} is waiting for review. Once approved, the worker will start automatically and show each step in Agent Tasks.`,provider:'confirmation-handler',model:'deterministic',usage:{inputTokens:1,outputTokens:35,totalTokens:36,estimatedCost:0}}:declining?{content:"No problem — I cancelled that pending request and did not create a task or make any network change.",provider:'confirmation-handler',model:'deterministic',usage:{inputTokens:1,outputTokens:20,totalTokens:21,estimatedCost:0}}:await provider.complete({agent,message:content,context,history,user:req.user,runtime});
    const newPendingAction=!confirming&&!declining?pendingTaskFromMessage(content,agent):null;
    const assistant=await req.prisma.aiAgentMessage.create({data:{conversationId:conversation.id,senderType:'AGENT',senderId:agent.id,role:'assistant',content:result.content,structuredData:{summary:`Handled by ${agent.name}`,agent:{id:agent.id,name:agent.name,slug:agent.slug,role:agent.role,department:agent.department,avatar:agent.avatar},routing:routed.routing,handoff,performed:context.performed||[],verifiedCustomerId:context.records?.customer?.id||operation?.data?.customer?.id||null,userRole:req.user.role,riskLevel:(operation?.approvalRequired||newPendingAction?.requiresApproval)?'HIGH':'LOW',approvalRequired:Boolean(operation?.approvalRequired||newPendingAction?.requiresApproval),pendingAction:newPendingAction,confirmation:{resolved:confirming||declining,accepted:confirming,taskId:confirmedTask?.task.id||null},sourceReferences:context.performed||[],provider:{name:result.provider,model:result.model,degraded:result.provider==='safe-fallback'},memory:{idleResetMinutes:10,reset:memoryExpired,expiresAt:new Date(Date.now()+memoryIdleMs).toISOString()}}}});
    await req.prisma.$transaction([req.prisma.aiAgentConversation.update({where:{id:conversation.id},data:{agentId:agent.id,lastMessageAt:new Date(),summary:context.records?.customer?.id?`Verified customer ${context.records.customer.id}`:`Active specialist: ${agent.name}`}}),req.prisma.aiAgentUsage.create({data:{ispId:req.ispId,agentId:agent.id,userId:req.user.id,modelProvider:result.provider,modelName:result.model,inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,totalTokens:result.usage.totalTokens,estimatedCost:result.usage.estimatedCost,durationMs:Date.now()-started}})]);
    if(handoff)await writeActivity(req,agent.id,'AGENT_HANDOFF',`Conversation ${conversation.id} handed off to ${agent.name}`,{conversationId:conversation.id,routing:routed.routing});
    return res.status(201).json({success:true,data:{userMessage:publicChatMessage(userMessage),assistant:publicChatMessage(assistant),agent,routing:routed.routing,performed:context.performed||[]}});
  }catch(error){return next(error);}
}

async function sendMessageContextual(req,res,next){
  try{
    const started=Date.now(),memoryIdleMs=10*60*1000,conversationId=parseId(req.params.id);
    const conversation=await req.prisma.aiAgentConversation.findFirst({where:{id:conversationId,ispId:req.ispId,userId:req.user.id}});
    if(!conversation)return res.status(404).json({error:'Conversation not found'});
    const content=cleanText(String(req.body.content||'').replace(/<[^>]*>/g,''));
    if(!content)return res.status(400).json({error:'Message is required'});
    const memoryExpired=Date.now()-new Date(conversation.lastMessageAt).getTime()>=memoryIdleMs;
    await ensureConversationState(req.prisma,{ispId:req.ispId,conversationId,userId:req.user.id,selectedAgentId:req.body.selectedAgentId||conversation.agentId,chatId:req.body.chatId||conversationId});
    if(memoryExpired){
      await req.prisma.$transaction([
        req.prisma.aiConversationContext.update({where:{conversationId},data:{currentIntent:null,previousIntent:null,currentModule:null,currentAction:null,currentEntityType:null,currentEntityId:null,selectedCustomerId:null,selectedDeviceId:null,selectedTicketId:null,selectedInvoiceId:null,selectedPaymentId:null,selectedNasId:null,pendingClarification:Prisma.DbNull,lastToolCall:Prisma.DbNull,lastToolResult:Prisma.DbNull,lastSuccessfulToolResult:Prisma.DbNull,lastAssistantClaim:Prisma.DbNull,entityStack:[],conversationSummary:null,debugTrace:Prisma.DbNull}}),
        req.prisma.aiEntityReference.updateMany({where:{ispId:req.ispId,conversationId,isActive:true},data:{isActive:false}}),
        req.prisma.aiPendingAgentAction.updateMany({where:{ispId:req.ispId,conversationId,status:{in:['DRAFT','AWAITING_CONFIRMATION']}},data:{status:'EXPIRED',error:'Confirmation expired after 10 minutes of inactivity.'}})
      ]);
    }
    const previous=memoryExpired?[]:await req.prisma.aiAgentMessage.findMany({where:{conversationId},orderBy:{createdAt:'desc'},take:30});
    const state=await loadConversationState(req.prisma,{ispId:req.ispId,conversationId,userId:req.user.id});
    const persisted=state.pendingAction;
    const carrier=previous.find(item=>item.role==='assistant'&&item.structuredData?.pendingAction);
    let pendingAction=persisted?{kind:'AI_AGENT_TASK',intent:'CREATE_NAS',toolName:persisted.toolName||'createNas',module:persisted.module,agentId:persisted.agentId,title:persisted.displayArguments?.title||`Create NAS ${persisted.displayArguments?.ipAddress||''}`,description:persisted.displayArguments?.description||'',taskType:persisted.actionType,priority:persisted.displayArguments?.priority||'HIGH',input:persisted.argumentsEncrypted,displayArguments:persisted.displayArguments,requiresApproval:persisted.requiresApproval,riskLevel:persisted.riskLevel,persistentId:persisted.id,status:persisted.status,approvalId:persisted.approvalId,taskId:persisted.taskId}:carrier?.structuredData?.pendingAction||null;
    if(!pendingAction){const earlier=findLegacyPendingRequest(previous);if(earlier){const noc=await req.prisma.aiAgent.findFirst({where:{ispId:req.ispId,status:'ACTIVE',slug:'noc'}});pendingAction=pendingTaskFromMessage(earlier,noc);}}
    const confirmationOpen=!pendingAction?.status||pendingAction.status==='AWAITING_CONFIRMATION';
    const confirming=Boolean(pendingAction&&confirmationOpen&&isAffirmative(content)),declining=Boolean(pendingAction&&['AWAITING_CONFIRMATION','AWAITING_APPROVAL','FAILED'].includes(pendingAction.status||'AWAITING_CONFIRMATION')&&isNegative(content));
    const history=previous.reverse(),resolution=resolveFollowUp(content,state,history);
    const provider=await getProvider({prisma:req.prisma,ispId:req.ispId});
    const structuredIntent=await resolveStructuredIntent({provider,message:resolution.resolvedMessage,state,history,authorizedTools:[]});
    if(!confirming&&!declining&&!['RESOLVE_CONTRADICTION','EXPLAIN_LAST_RESULT'].includes(resolution.intent)){
      resolution.intent=structuredIntent.intent||resolution.intent;resolution.action=structuredIntent.action||resolution.action;resolution.module=structuredIntent.domain||resolution.module;resolution.entityType=structuredIntent.domain||resolution.entityType;
    }
    const storedContent=/\b(?:password|passwd|pwd|shared\s*secret|api\s*secret|secret(?:\s*key)?)\b/i.test(content)?stripSecrets(content):content;
    const userMessage=await req.prisma.aiAgentMessage.create({data:{conversationId,senderType:'USER',senderId:req.user.id,role:'user',content:storedContent,structuredData:{chatId:String(req.body.chatId||conversationId),conversationId,userId:req.user.id,tenantId:req.ispId,selectedAgentId:req.body.selectedAgentId||null,parentMessageId:req.body.parentMessageId||null,currentRoute:cleanText(req.body.currentRoute,255)||null,selectedContext:req.body.selectedContext||null,resolvedIntent:resolution.intent,resolvedMessage:resolution.resolvedMessage!==content?resolution.resolvedMessage:null},attachments:Array.isArray(req.body.attachments)?req.body.attachments.slice(0,5):[]}});
    let operation=null,confirmedTask=null,orchestration=null;
    if(confirming){confirmedTask=await createConfirmedTask(req,pendingAction);operation={operation:'createAiAgentTask',performed:['createAutomationTask'],data:{task:{...confirmedTask.task,input:publicTaskInput(confirmedTask.task.input)},approval:confirmedTask.approval}};if(pendingAction.persistentId)await updatePendingAction(req.prisma,{conversationId,actionId:pendingAction.persistentId,status:'AWAITING_APPROVAL',approvalId:confirmedTask.approval.id,taskId:confirmedTask.task.id});}
    if(declining&&pendingAction?.persistentId){await updatePendingAction(req.prisma,{conversationId,actionId:pendingAction.persistentId,status:'CANCELLED'});if(pendingAction.approvalId)await req.prisma.aiAgentApproval.updateMany({where:{id:pendingAction.approvalId,ispId:req.ispId,status:'PENDING'},data:{status:'REJECTED',reason:'Cancelled by the requesting user in AI Chat.',rejectedAt:new Date()}});if(pendingAction.taskId)await req.prisma.aiAgentTask.updateMany({where:{id:pendingAction.taskId,ispId:req.ispId,status:{in:['WAITING_APPROVAL','PENDING','FAILED','BLOCKED']}},data:{status:'CANCELLED',error:'Cancelled by the requesting user.',completedAt:new Date()}});}
    let routed=confirmedTask?{agent:confirmedTask.agent,routing:{slug:confirmedTask.agent.slug,confidence:1,matched:['confirmed pending action'],reason:'pending_action'}}:await resolveAgent(req.prisma,req.ispId,resolution.resolvedMessage,req.body.selectedAgentId||req.body.agentId,structuredIntent);
    if(operation&&!confirmedTask){const slug=agentSlugForOperation(operation);const specialist=await req.prisma.aiAgent.findFirst({where:{ispId:req.ispId,slug,status:'ACTIVE'}});if(specialist)routed={agent:specialist,routing:{slug,confidence:.98,matched:[operation.operation],operation:true,reason:'operation_intent'}};}
    const agent=routed.agent||await req.prisma.aiAgent.findFirst({where:{id:conversation.agentId,ispId:req.ispId,status:'ACTIVE'}});if(!agent)return res.status(409).json({error:'The selected specialist is not active.'});
    const handoff=agent.id!==conversation.agentId;
    const contextMessage=[state.conversationSummary,...history.map(item=>`${item.role}: ${item.content}`),`user: ${resolution.resolvedMessage}`].filter(Boolean).join('\n');
    const context=await collectAgentContext({prisma:req.prisma,ispId:req.ispId,agent,message:contextMessage,currentMessage:resolution.resolvedMessage,user:req.user});context.records=context.records||{};
    context.records.conversationState={chatId:String(req.body.chatId||conversationId),conversationId,currentIntent:resolution.intent,currentModule:resolution.module,selectedCustomerId:state.selectedCustomerId,selectedDeviceId:state.selectedDeviceId,pendingAction:pendingAction?publicPendingAction(pendingAction):null,lastToolResult:state.lastToolResult,conversationSummary:state.conversationSummary};
    const [runtimeTools,runtimePermissions,runtimeKnowledge]=await Promise.all([req.prisma.aiAgentTool.findMany({where:{agentId:agent.id,enabled:true}}),req.prisma.aiAgentPermission.findMany({where:{agentId:agent.id}}),req.prisma.aiAgentKnowledgeSource.findMany({where:{agentId:agent.id,enabled:true}})]),runtime={tools:runtimeTools,permissions:runtimePermissions,knowledge:runtimeKnowledge};
    if(!confirming&&!declining){
      try{
        const secureRequest=extractTaskCredentials(content,{});
        orchestration=await orchestrateTools({provider,prisma:req.prisma,ispId:req.ispId,conversationId,user:req.user,agent,runtime,state,history,message:content,resolvedMessage:resolution.resolvedMessage,context,secureArguments:secureRequest?.sharedSecret?{sharedSecret:secureRequest.sharedSecret}:null,pendingActionId:persisted?.id||null,requestId:req.headers['x-request-id']||`chat-${conversationId}-${userMessage.id}`});
        operation=orchestration.operation;
      }catch(error){console.error('[AI tool orchestration failed]',{code:error.code,message:error.message,conversationId});operation={operation:'operationError',approvalRequired:false,error:error.message||'The trusted tool could not complete this request.',errorCode:error.code||'TOOL_ERROR'};}
      if(!operation){try{operation=await executeOperation({prisma:req.prisma,ispId:req.ispId,user:req.user,message:resolution.resolvedMessage,contextMessage});}catch(error){console.error('[AI operation fallback failed]',error);operation={operation:'operationError',approvalRequired:false,error:'The verified backend operation failed. Please review the operation log.',errorCode:error.code||'OPERATION_ERROR'};}}
    }
    let nasDraft=null;
    if(!confirming&&!declining&&['prepareCreateNasApproval','prepareUpdateNasApproval'].includes(operation?.operation)){
      nasDraft=await prepareNasPendingAction(req,content,agent);
      if(nasDraft?.missingFields?.length)operation={operation:'nasClarification',approvalRequired:false,performed:['validateNasRequest'],data:{missingFields:nasDraft.missingFields,hardwareRequested:Boolean(nasDraft.input.hardwareRequested)}};
    }
    if(operation){context.records.operation=operation;context.performed=[...new Set([...(context.performed||[]),...(operation.performed||[])])];context.kind='RECORDS';}
    const contradiction=resolution.intent==='RESOLVE_CONTRADICTION',verifiedDevice=operation?.data?.device;
    const result=confirming?{content:`Confirmed. I created task #${confirmedTask.task.id} and approval #${confirmedTask.approval.id}. The secret is masked. After approval, ${confirmedTask.agent.name} will ${confirmedTask.task.taskType==='NAS_UPDATE'?'update':'create'} the NAS in CMS, synchronize Radius${confirmedTask.task.input?.hardwareRequested?', and configure and verify the MikroTik device. No hardware failure will be hidden.':'. No hardware login or device change will be attempted.'}`,provider:'confirmation-handler',model:'deterministic',usage:{inputTokens:1,outputTokens:45,totalTokens:46,estimatedCost:0}}:declining?{content:'No problem — I cancelled the pending request. No task was created and no network change was made.',provider:'confirmation-handler',model:'deterministic',usage:{inputTokens:1,outputTokens:20,totalTokens:21,estimatedCost:0}}:contradiction&&verifiedDevice?{content:`You're right to question that. I rechecked the customer-to-device mapping and verified TR-069 device ${verifiedDevice.serialNumber}${state.selectedCustomerId?` linked to ${state.selectedCustomerId}`:''}. Its current status is ${verifiedDevice.status||'unknown'}${verifiedDevice.ipAddress?` and its IP is ${verifiedDevice.ipAddress}`:''}. I saved this corrected device in the conversation context.`,provider:'correction-handler',model:'deterministic',usage:{inputTokens:10,outputTokens:55,totalTokens:65,estimatedCost:0}}:operation?.operation==='nasClarification'?{content:`I need ${operation.data.missingFields.join(', ')} before I can prepare this NAS task.${operation.data.hardwareRequested?' Hardware configuration also requires a reachable device and valid SSH or Telnet access.':''}`,provider:'nas-validation-handler',model:'deterministic',usage:{inputTokens:5,outputTokens:30,totalTokens:35,estimatedCost:0}}:['prepareCreateNasApproval','prepareUpdateNasApproval'].includes(operation?.operation)?{content:`I can prepare the NAS ${operation.operation==='prepareUpdateNasApproval'?'update':'creation'}${operation.data?.nasIp?` for ${operation.data.nasIp}`:''}. This sensitive change requires approval. Any provided secret is encrypted and masked.${nasDraft?.input.hardwareRequested?' The task includes MikroTik configuration and verification.':' This is CMS and Radius only; it will not log in to hardware.'} Do you want me to proceed?`,provider:'pending-action-handler',model:'deterministic',usage:{inputTokens:10,outputTokens:34,totalTokens:44,estimatedCost:0}}:operation?.operation==='operationError'?{content:'I could not run the specialist tool for this request. Please check the AI provider configuration or try again shortly.',provider:'tool-error-handler',model:'deterministic',usage:{inputTokens:1,outputTokens:22,totalTokens:23,estimatedCost:0}}:orchestration?.providerResult?.content?orchestration.providerResult:await provider.complete({agent,message:resolution.resolvedMessage,context,history,user:req.user,runtime});
    let newPendingAction=!confirming&&!declining&&['prepareCreateNasApproval','prepareUpdateNasApproval'].includes(operation?.operation)&&nasDraft&&!nasDraft.missingFields.length?nasDraft:null,persistedPending=null;if(newPendingAction){persistedPending=await createPendingAction(req.prisma,{ispId:req.ispId,conversationId,agentId:agent.id,requestedBy:req.user.id,action:newPendingAction});newPendingAction={...newPendingAction,persistentId:persistedPending.id,status:persistedPending.status};}
    const debugTrace={requestId:req.headers['x-request-id']||`chat-${conversationId}-${userMessage.id}`,chatId:String(req.body.chatId||conversationId),conversationId,tenantId:req.ispId,userId:req.user.id,selectedAgent:req.body.selectedAgentId||conversation.agentId,routedAgent:agent.slug,detectedLanguage:structuredIntent.language,resolvedIntent:resolution.intent,resolvedAction:structuredIntent.action,resolvedDomain:structuredIntent.domain,intentSource:structuredIntent.source,intentConfidence:structuredIntent.confidence,resolution:resolution.resolution,contextLoaded:Boolean(state.id),resolvedEntity:{customerId:state.selectedCustomerId,deviceId:state.selectedDeviceId,nasId:state.selectedNasId},pendingActionFound:Boolean(pendingAction),selectedTool:orchestration?.selectedTool||operation?.operation||null,authorizedTools:orchestration?.authorizedTools||[],toolArguments:{message:stripSecrets(resolution.resolvedMessage)},toolResult:operation?{operation:operation.operation,error:operation.error||null,errorCode:operation.errorCode||null,found:operation.data?.found}:null,toolStatus:operation?.approvalRequired?'AWAITING_APPROVAL':operation?.error?'FAILED':operation?'COMPLETED':null,approvalState:confirmedTask?.approval?.status||persisted?.status||null,provider:result.provider,model:result.model,tokenUsage:result.usage,finalResponseType:confirming?'CONFIRMATION':declining?'CANCELLATION':contradiction?'CORRECTION':operation?'TOOL_RESULT':'CONVERSATION',fallbackReason:structuredIntent.fallbackReason||(result.provider==='safe-fallback'&&!operation?'NO_OPERATION_MATCH':null)};
    const assistant=await req.prisma.aiAgentMessage.create({data:{conversationId,senderType:'AGENT',senderId:agent.id,role:'assistant',content:result.content,toolCalls:operation?[{name:operation.operation,arguments:{resolvedMessage:stripSecrets(resolution.resolvedMessage)},result:{error:operation.error||null,performed:operation.performed||[],data:operation.data||null}}]:null,structuredData:{summary:`Handled by ${agent.name}`,agent:{id:agent.id,name:agent.name,slug:agent.slug,role:agent.role,department:agent.department,avatar:agent.avatar},routing:routed.routing,handoff,performed:context.performed||[],resolvedIntent:resolution.intent,resolution:resolution.resolution,userRole:req.user.role,riskLevel:(operation?.approvalRequired||newPendingAction?.requiresApproval)?'HIGH':'LOW',approvalRequired:Boolean(operation?.approvalRequired||newPendingAction?.requiresApproval),pendingAction:newPendingAction?publicPendingAction(newPendingAction):null,confirmation:{resolved:confirming||declining,accepted:confirming,taskId:confirmedTask?.task.id||null,approvalId:confirmedTask?.approval.id||null},provider:{name:result.provider,model:result.model,degraded:result.provider==='safe-fallback'},memory:{idleResetMinutes:10,reset:memoryExpired,expiresAt:new Date(Date.now()+memoryIdleMs).toISOString()}}}});
    const savedState=await saveTurnState(req.prisma,{ispId:req.ispId,conversationId,userId:req.user.id,chatId:req.body.chatId||conversationId,selectedAgentId:req.body.selectedAgentId||conversation.agentId,routedAgentId:agent.id,resolution,operation,assistantMessage:assistant,route:{fromAgentId:conversation.agentId,toAgentId:agent.id,confidence:routed.routing?.confidence,reason:routed.routing?.reason},debugTrace});
    if(contradiction)await req.prisma.aiConversationCorrection.create({data:{ispId:req.ispId,conversationId,userMessageId:userMessage.id,disputedMessageId:history.slice().reverse().find(item=>item.role==='assistant')?.id||null,entityType:'DEVICE',entityId:verifiedDevice?.serialNumber||state.selectedDeviceId||null,previousClaim:state.lastAssistantClaim?.content||null,correctedClaim:result.content,verificationResult:operation||null,status:verifiedDevice?'RESOLVED':'NEEDS_REVIEW'}});
    await req.prisma.$transaction([req.prisma.aiAgentConversation.update({where:{id:conversationId},data:{agentId:agent.id,lastMessageAt:new Date(),summary:savedState.conversationSummary}}),req.prisma.aiAgentUsage.create({data:{ispId:req.ispId,agentId:agent.id,userId:req.user.id,modelProvider:result.provider,modelName:result.model,inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,totalTokens:result.usage.totalTokens,estimatedCost:result.usage.estimatedCost,durationMs:Date.now()-started}}),req.prisma.aiAgentActivityLog.create({data:{ispId:req.ispId,agentId:agent.id,userId:req.user.id,eventType:'CHAT_CONTEXT_RESOLVED',description:`Conversation ${conversationId}: ${resolution.intent||'conversation'} handled by ${agent.name}`,metadata:debugTrace}})]);
    if(handoff)await writeActivity(req,agent.id,'AGENT_HANDOFF',`Conversation ${conversationId} handed off to ${agent.name}`,{conversationId,routing:routed.routing,resolvedIntent:resolution.intent});
    return res.status(201).json({success:true,data:{userMessage:publicChatMessage(userMessage),assistant:publicChatMessage(assistant),agent,routing:routed.routing,performed:context.performed||[],conversationState:{...savedState,pendingAction:newPendingAction?publicPendingAction(newPendingAction):pendingAction?publicPendingAction(pendingAction):null}}});
  }catch(error){return next(error);}
}

module.exports={listAgents,createAgent,listToolCatalog,getAgent,updateAgent,cloneAgent,publishAgent:changeAgentState('PUBLISHED'),pauseAgent:changeAgentState('PAUSED'),activateAgent:changeAgentState('ACTIVE'),getAgentTools,updateAgentTools,getAgentPermissions,updateAgentPermissions,listTasks,createTask,updateTaskStatus,listApprovals,decideApproval,listActivity,listUsage,getAnalytics,listConversations,routeIntent,createConversation,getConversation,updateConversation,listMessages,getConversationContext,sendMessage:sendMessageContextual,startTaskWorker,processQueuedTasks,__test:{isAffirmative,isNegative,findLegacyPendingRequest,pendingTaskFromMessage,publicPendingAction}};
