const {createAdapter}=require('./device-adapter.service');
const {classifyError}=require('./device-connection.service');
const {audit}=require('./device-audit.service');
const TelemetryAlarmService=require('./telemetry-alarm.service');
class DeviceStatusService{
 constructor(prisma,connections){this.prisma=prisma;this.connections=connections;this.alarms=new TelemetryAlarmService(prisma);this.running=new Set();this.timer=null;}
 async refresh(device,{userId=null,sourceIp=null,auditEvent=true}={}){
  if(this.running.has(device.id))throw Object.assign(new Error('A status check is already running for this device.'),{status:409,code:'STATUS_CHECK_RUNNING'});
  if(device.status==='maintenance')return{status:'maintenance',message:device.maintenanceReason||'Maintenance mode'};
  this.running.add(device.id);const started=Date.now();let result;
  try{
   const health=await createAdapter(device,this.connections).testConnection(),now=new Date();
   result={status:'online',message:'Connection and health check succeeded.',latencyMs:health.latencyMs,profile:health.profile,protocol:health.protocol||health.method,legacyCompatibilityUsed:health.legacyCompatibilityUsed};
   await this.prisma.managedDevice.update({where:{id:device.id},data:{status:'online',statusMessage:result.message,failureReason:null,lastConnectionError:null,lastConnectionDiagnostics:health.diagnostics,lastCheckedAt:now,lastSeenAt:now,lastSuccessfulConnectionAt:now,sshProfile:health.profile||device.sshProfile,consecutiveFailureCount:0}});
   await this.prisma.managedDeviceConnection.create({data:{deviceId:device.id,userId,method:String(result.protocol||device.communicationMethod).slice(0,24),success:true,durationMs:Date.now()-started,message:result.message,profile:health.profile,profilesAttempted:health.profilesAttempted,diagnostics:health.diagnostics}});
  }catch(error){
   const type=classifyError(error),offline=['DEVICE_HOST_UNREACHABLE','DEVICE_CONNECTION_TIMEOUT','DEVICE_CONNECTION_REFUSED','DEVICE_CONNECTION_RESET'].includes(type),now=new Date(),negotiation=error.negotiation||{};
   result={status:offline?'offline':'failure',message:String(error.message||error).slice(0,1000),failureType:type,errorCode:error.code||type,latencyMs:Date.now()-started};
   await this.prisma.managedDevice.update({where:{id:device.id},data:{status:result.status,statusMessage:result.message,failureReason:result.message,lastConnectionError:result.message,lastConnectionDiagnostics:{errorCode:result.errorCode,errorCategory:negotiation.category||type,algorithmDirection:negotiation.direction||null,profilesAttempted:error.profilesAttempted||[]},lastCheckedAt:now,lastFailureAt:now,consecutiveFailureCount:{increment:1}}});
   await this.prisma.managedDeviceConnection.create({data:{deviceId:device.id,userId,method:String(device.preferredProtocol||device.communicationMethod).slice(0,24),success:false,durationMs:Date.now()-started,failureType:type,message:result.message,profile:error.profile,profilesAttempted:error.profilesAttempted,errorCode:result.errorCode,errorCategory:negotiation.category||type,algorithmDirection:negotiation.direction,algorithmType:negotiation.category,diagnostics:{errorCode:result.errorCode,profilesAttempted:error.profilesAttempted||[]}}});
  }finally{this.running.delete(device.id);}
  await this.prisma.managedDeviceStatusHistory.create({data:{deviceId:device.id,status:result.status,message:result.message,latencyMs:result.latencyMs}});
  if(auditEvent)await audit(this.prisma,{ispId:device.ispId,deviceId:device.id,userId,action:'DEVICE_STATUS_REFRESH',success:result.status==='online',sourceIp,response:result,failureReason:result.status==='online'?null:result.message});
  let health=null;
  if(result.status==='online'&&await this.alarms.hasMetricRules(device.ispId)){
   try{health=await createAdapter(device,this.connections).read('health',{ispId:device.ispId,userId});}catch(error){console.error('[DEVICE ALARM HEALTH]',device.id,error.message);}
  }
  await this.alarms.evaluate(device,{connection:{status:result.status},health}).catch(error=>console.error('[DEVICE ALARM]',device.id,error.message));
  return result;
 }
 async poll(){const now=new Date(),devices=await this.prisma.managedDevice.findMany({where:{isDeleted:false,enabled:true,pollingEnabled:true,status:{not:'maintenance'}}}),due=devices.filter(device=>{if(!device.lastCheckedAt)return true;const failures=Math.min(6,Math.max(0,Number(device.consecutiveFailureCount||0))),backoff=Math.min(3600,Math.max(10,Number(device.pollingInterval||300))*2**failures);return now-new Date(device.lastCheckedAt)>=backoff*1000;}),limit=Number(process.env.DEVICE_POLL_CONCURRENCY||5);for(let index=0;index<due.length;index+=limit)await Promise.allSettled(due.slice(index,index+limit).map(device=>this.refresh(device,{auditEvent:false})));const retentionDays=Number(process.env.DEVICE_STATUS_RETENTION_DAYS||30),cutoff=new Date(Date.now()-retentionDays*86400000);await this.prisma.managedDeviceStatusHistory.deleteMany({where:{checkedAt:{lt:cutoff}}});}
 start(){if(this.timer||process.env.DEVICE_POLLING_ENABLED==='false')return;const interval=Math.max(30000,Number(process.env.DEVICE_POLL_TICK_MS||60000));this.timer=setInterval(()=>this.poll().catch(error=>console.error('[DEVICE POLLING]',error.message)),interval);this.timer.unref?.();setTimeout(()=>this.poll().catch(error=>console.error('[DEVICE POLLING]',error.message)),5000).unref?.();}
 stop(){if(this.timer)clearInterval(this.timer);this.timer=null;this.connections.closeAll();}
}
module.exports=DeviceStatusService;
