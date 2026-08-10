const crypto=require('crypto');
const {DeviceConnectionService,sanitizeOutput,routerOsRestPath}=require('./device-connection.service');
const {DeviceService}=require('./device.service');
const {createAdapter,COMMANDS}=require('./device-adapter.service');
const {normalizeDeviceResponse}=require('./device-response-normalizer.service');
const mailHelper = require('../../utils/mailHelper');
const whatsappService = require('../whatsapp.service');
const TelemetryAlarmService = require('./telemetry-alarm.service');

const READ_PERMISSIONS=['devices_read','devices_view','devices_live_dashboard','olt_read','bng_read'];
class DeviceWebSocketService{
  constructor(manager,prisma){this.manager=manager;this.prisma=prisma;this.connections=new DeviceConnectionService(prisma);this.devices=new DeviceService(prisma,{onCriticalChange:id=>this.connections.closeForDevice(id,'DEVICE_SETTINGS_CHANGED')});this.alarms=new TelemetryAlarmService(prisma);this.connections.onEvent=(type,data)=>manager.broadcastToRoom(`tenant:${data.tenantId||''}:device:${data.deviceId}`,type,safe(data));this.clientSessions=new Map();this.pollers=new Map();}
  permitted(client,names=READ_PERMISSIONS){return client.permissions.has('*')||names.some(name=>client.permissions.has(name))||['administrator','global manager'].includes(String(client.role||'').toLowerCase());}
  async handle(clientId,message){const client=this.manager.clients.get(clientId);if(!client)return;const data=message.data||{},requestId=data.requestId||crypto.randomUUID();try{if(!this.permitted(client))throw coded('DEVICE_ACCESS_DENIED','You do not have permission to access live devices.',403);const device=await this.devices.getInternal(client.ispId,data.deviceId),room=`tenant:${client.ispId}:device:${device.id}`;switch(message.type){
    case'device:room:join':this.manager.joinRoom(clientId,room);return this.reply(clientId,'device:room:joined',{requestId,deviceId:device.id,status:'READY'});
    case'device:room:leave':this.manager.leaveRoom?.(clientId,room);this.detach(clientId,device.id);return this.reply(clientId,'device:room:left',{requestId,deviceId:device.id,status:'CLOSED'});
    case'device:session:open':case'device:session:reuse':{this.manager.joinRoom(clientId,room);const session=await this.connections.sessions.getOrCreateSession({ispId:client.ispId,userId:client.userId,device,socketId:clientId,requestedProtocol:data.requestedProtocol||'AUTO'});this.track(clientId,device.id,session.publicSessionId);return this.reply(clientId,'device:connection:ready',{requestId,...this.connections.sessions.public(session),status:'READY'});}
    case'device:session:touch':{const session=this.session(clientId,device.id);if(!session)throw coded('DEVICE_SESSION_EXPIRED','Open the device session again.',409);this.connections.sessions.touch(session,clientId);return this.reply(clientId,'device:session:touched',{requestId,...this.connections.sessions.public(session)});}
    case'device:session:close':this.detach(clientId,device.id);return this.reply(clientId,'device:connection:disconnected',{requestId,deviceId:device.id,status:'CLOSED'});
    case'device:dashboard:subscribe':case'device:dashboard:refresh':{const session=await this.ensure(clientId,client,device,data);const snapshot=await this.snapshot(device,client,clientId);this.startPolling(session,device,client);return this.reply(clientId,'device:dashboard:snapshot',{requestId,sessionId:session.publicSessionId,deviceId:device.id,protocol:session.protocol,status:'READY',timestamp:new Date().toISOString(),data:snapshot});}
    case'device:dashboard:unsubscribe':this.stopSubscriber(clientId,device.id);return this.reply(clientId,'device:dashboard:unsubscribed',{requestId,deviceId:device.id,status:'READY'});
    case'device:interfaces:subscribe':case'device:vlans:subscribe':case'device:routing:subscribe':case'device:optics:subscribe':case'device:alarms:subscribe':{const module=message.type.split(':')[1],session=await this.ensure(clientId,client,device,data),result=await this.readModule(device,module==='vlans'?'interfaces':module==='optics'?'optics':module==='alarms'?'health':module,client);return this.reply(clientId,`device:${module}:update`,{requestId,sessionId:session.publicSessionId,deviceId:device.id,protocol:result.meta?.protocol||session.protocol,status:'READY',timestamp:new Date().toISOString(),data:safe(result)});}
    default:throw coded('DEVICE_EVENT_UNSUPPORTED','Unsupported device socket event.',400);
  }}catch(error){this.reply(clientId,'device:connection:error',{requestId,deviceId:Number(data.deviceId)||null,status:'FAILED',errorCode:error.code||'DEVICE_UNKNOWN_ERROR',message:userMessage(error)});}}
  async ensure(clientId,client,device,data){let session=this.session(clientId,device.id);if(!session||!this.connections.sessions.healthy(session)){session=await this.connections.sessions.getOrCreateSession({ispId:client.ispId,userId:client.userId,device,socketId:clientId,requestedProtocol:data.requestedProtocol||'AUTO'});this.track(clientId,device.id,session.publicSessionId);}return session;}
  async snapshot(device,client,clientId){const session=await this.ensure(clientId,client,device,{}),base={identity:{id:device.id,name:device.name,vendor:device.vendor,deviceType:device.deviceType,model:device.model,platform:device.platform,operatingSystem:device.operatingSystem,operatingSystemVersion:device.operatingSystemVersion,firmwareVersion:device.firmwareVersion,serialNumber:device.serialNumber,managementAddress:device.host},connection:{status:device.status,lastSeenAt:device.lastSeenAt,protocol:session.protocol}},hasTraffic=Object.prototype.hasOwnProperty.call(COMMANDS[device.deviceType]||{},'traffic'),huawei=device.deviceType==='huawei-olt',modules=['system','health',hasTraffic?'traffic':'interfaces',...(huawei?[]:['routes'])],keys=['system','health',hasTraffic?'telemetry':'interfaces',...(huawei?[]:['routing'])],reads=await Promise.allSettled(modules.map(module=>this.readModule(device,module,client)));keys.forEach((key,index)=>{const result=reads[index];base[key]=result.status==='fulfilled'?safe(result.value):{partialFailure:true,errorCode:result.reason?.code||'DEVICE_API_ERROR',message:userMessage(result.reason)};});if(hasTraffic)base.interfaces=base.telemetry;base.connection.protocols=[...new Set(keys.map(key=>base[key]?.meta?.protocol).filter(Boolean))];try{this.alarms.evaluate(device,base).catch(err=>console.error('[Alarm Evaluation Error]:',err.message));}catch(e){}return base;}
  async readModule(device,module,client){return createAdapter(device,this.connections).read(module,{ispId:client.ispId,userId:client.userId});}
  async readSession(session,device,module){const adapter=createAdapter(device,this.connections),command=session.protocol==='SNMP'?module:adapter.commandFor(module),routerApi=['ROUTEROS_API','ROUTEROS_API_TLS'].includes(session.protocol),rest=session.protocol==='ROUTEROS_REST',vendorApi=['VENDOR_API','RESTCONF'].includes(session.protocol),started=Date.now(),data=await this.connections.sessions.run(session,async transport=>sanitizeOutput(session.protocol==='SNMP'?await transport.getModule(module):routerApi?await transport.get(command):rest?await transport.get(routerOsRestPath(command)):vendorApi?await transport.get(command):await transport.runShellSession(send=>send(command,800))));return normalizeDeviceResponse({device,module,command,data,durationMs:Date.now()-started,protocol:session.protocol});}
  startPolling(session,device,client){if(this.pollers.has(session.publicSessionId))return;let running=false;const apiSession=['ROUTEROS_API','ROUTEROS_API_TLS','ROUTEROS_REST','VENDOR_API','RESTCONF','SNMP'].includes(session.protocol),interval=apiSession?Math.max(5000,Math.min(15000,Number(device.pollingInterval||15)*1000)):Math.max(10000,Math.min(15000,Number(device.pollingInterval||15)*1000)),timer=setInterval(async()=>{if(!session.subscribers.size||running)return;running=true;try{const data=await this.snapshot(device,client,[...session.subscribers][0]||client.id);this.manager.broadcastToRoom(`tenant:${client.ispId}:device:${device.id}`,'device:dashboard:snapshot',{requestId:crypto.randomUUID(),sessionId:session.publicSessionId,deviceId:device.id,protocol:session.protocol,status:'READY',timestamp:new Date().toISOString(),data:safe(data)});}catch(error){this.manager.broadcastToRoom(`tenant:${client.ispId}:device:${device.id}`,'device:dashboard:update',{requestId:crypto.randomUUID(),sessionId:session.publicSessionId,deviceId:device.id,status:'PARTIAL',timestamp:new Date().toISOString(),errorCode:error.code||'DEVICE_API_ERROR'});}finally{running=false;}},interval);timer.unref?.();this.pollers.set(session.publicSessionId,timer);session.pollingJobs.set('dashboard',timer);}
  track(clientId,deviceId,sessionId){if(!this.clientSessions.has(clientId))this.clientSessions.set(clientId,new Map());this.clientSessions.get(clientId).set(Number(deviceId),sessionId);}
  session(clientId,deviceId){const id=this.clientSessions.get(clientId)?.get(Number(deviceId));return id?this.connections.sessions.publicIndex.get(id):null;}
  stopSubscriber(clientId,deviceId){const session=this.session(clientId,deviceId);if(session)this.connections.sessions.release(session,clientId);}
  detach(clientId,deviceId){const session=this.session(clientId,deviceId);if(session)this.connections.sessions.release(session,clientId);this.clientSessions.get(clientId)?.delete(Number(deviceId));}
  handleDisconnect(clientId){for(const deviceId of this.clientSessions.get(clientId)?.keys()||[])this.detach(clientId,deviceId);this.clientSessions.delete(clientId);}
  reply(clientId,type,data){this.manager.sendToClient(clientId,type,safe(data));}
  
  async sendAlertNotification(ispId, channel, recipient, subject, message) {
    console.log(`[ALERT DISPATCH] Channel: ${channel} | Recipient: ${recipient} | Msg: ${message}`);
    if (channel === 'Email') {
      try {
        await mailHelper.sendMail({
          to: recipient,
          subject,
          text: message
        });
      } catch (err) {
        console.error(`[Alert Email Error]:`, err.message);
      }
    } else if (channel === 'SMS') {
      try {
        console.log(`[Alert SMS] Dispatched to ${recipient}: ${message}`);
      } catch (err) {
        console.error(`[Alert SMS Error]:`, err.message);
      }
    } else if (channel === 'WhatsApp') {
      try {
        await whatsappService.sendMessage(ispId, recipient, message);
      } catch (err) {
        console.error(`[Alert WhatsApp Error]:`, err.message);
      }
    }
  }

  async evaluateAlertRules(device, base) {
    this.lastTriggeredAlarms = this.lastTriggeredAlarms || new Map();
    const settings = await this.prisma.iSPSettings.findFirst({
      where: { key: 'telemetry_alarm_rules' }
    });
    if (!settings || !settings.value) return;
    let rules = [];
    try {
      rules = JSON.parse(settings.value);
    } catch (e) {
      return;
    }
    if (!Array.isArray(rules)) return;
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      let triggered = false;
      let currentVal = null;
      if (rule.metric === 'status') {
        triggered = base.connection?.status !== 'online';
        currentVal = base.connection?.status;
      } else {
        const healthObj = Array.isArray(base.health) ? base.health[0] : base.health;
        const val = healthObj?.[rule.metric];
        if (val !== undefined && val !== null) {
          currentVal = val;
          const numVal = Number(val);
          const limit = Number(rule.value);
          if (rule.operator === 'gt') triggered = numVal > limit;
          else if (rule.operator === 'lt') triggered = numVal < limit;
          else if (rule.operator === 'eq') triggered = numVal === limit;
        }
      }
      if (triggered) {
        const key = `${rule.id}_${device.id}`;
        const lastTime = this.lastTriggeredAlarms.get(key) || 0;
        const cooldownMs = (rule.cooldownMinutes || 15) * 60 * 1000;
        if (Date.now() - lastTime >= cooldownMs) {
          this.lastTriggeredAlarms.set(key, Date.now());
          const subject = `ALERT: Device ${device.name} triggered ${rule.name}`;
          const message = `Device: ${device.name} (${device.host})\nRule: ${rule.name}\nMetric: ${rule.metric}\nValue: ${currentVal} (threshold: ${rule.operator} ${rule.value})\nTimestamp: ${new Date().toLocaleString()}`;
          const channels = Array.isArray(rule.channels) ? rule.channels : ['Email'];
          const recipients = rule.recipients || '';
          for (const channel of channels) {
            await this.sendAlertNotification(device.ispId, channel, recipients, subject, message);
          }
        }
      }
    }
  }

  close(){for(const timer of this.pollers.values())clearInterval(timer);this.pollers.clear();this.connections.closeAll();}
}
const safe=value=>sanitizeOutput(value);
const coded=(code,message,status)=>Object.assign(new Error(message),{code,status});
const userMessage=error=>{const known=/^DEVICE_|^SSH_ALGORITHM_/.test(error.code||'');return known?String(error.message||'Device operation failed.').slice(0,500):'The device operation failed. Review connection diagnostics.';};
module.exports=DeviceWebSocketService;
