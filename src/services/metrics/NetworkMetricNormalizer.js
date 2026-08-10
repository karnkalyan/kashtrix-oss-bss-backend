const RATE_UNITS=[['Tbps',1e12],['Gbps',1e9],['Mbps',1e6],['kbps',1e3],['bps',1]];
const STORAGE_UNITS=['B','KiB','MiB','GiB','TiB','PiB'];

function finiteNumber(value){
  if(value===null||value===undefined||value==='')return null;
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:null;
}

function compact(value,maximumFractionDigits=2){
  return new Intl.NumberFormat('en-US',{maximumFractionDigits,minimumFractionDigits:0,useGrouping:false}).format(value);
}

function formatNetworkRate(value){
  const bps=finiteNumber(value);
  if(bps===null||bps<0)return 'N/A';
  const [unit,scale]=RATE_UNITS.find(([,candidate])=>bps>=candidate)||RATE_UNITS[RATE_UNITS.length-1];
  return `${compact(bps/scale)} ${unit}`;
}

function formatStorageSize(value){
  const bytes=finiteNumber(value);
  if(bytes===null||bytes<0)return 'N/A';
  if(bytes===0)return '0 B';
  const exponent=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),STORAGE_UNITS.length-1);
  return `${compact(bytes/(1024**exponent))} ${STORAGE_UNITS[exponent]}`;
}

function formatPacketRate(value){
  const pps=finiteNumber(value);
  if(pps===null||pps<0)return 'N/A';
  if(pps>=1e6)return `${compact(pps/1e6)}M pps`;
  if(pps>=1e3)return `${compact(pps/1e3)}k pps`;
  return `${compact(pps)} pps`;
}

function integer(value){
  try{return typeof value==='bigint'?value:BigInt(String(value));}catch{return null;}
}

function counterDelta(previous,current,counterBits){
  const before=integer(previous),after=integer(current);
  if(before===null||after===null||before<0n||after<0n)return{delta:null,status:'invalid_counter'};
  if(after>=before)return{delta:after-before,status:'ok'};
  if(![32,64].includes(counterBits))return{delta:null,status:'counter_reset'};
  const modulus=1n<<BigInt(counterBits),nearTop=before>=modulus*9n/10n,nearBottom=after<=modulus/10n;
  if(!nearTop||!nearBottom)return{delta:null,status:'counter_reset'};
  return{delta:(modulus-before)+after,status:'rollover'};
}

function calculateCounterRate(previous,current,options={}){
  if(!previous)return{bps:null,status:'pending',stale:false,utilizationPercent:null};
  const previousAt=finiteNumber(previous.timestamp),currentAt=finiteNumber(current?.timestamp);
  if(previousAt===null||currentAt===null||currentAt<=previousAt)return{bps:null,status:'invalid_timestamp',stale:false,utilizationPercent:null};
  const previousUptime=finiteNumber(previous.uptimeSeconds),currentUptime=finiteNumber(current?.uptimeSeconds);
  if(previousUptime!==null&&currentUptime!==null&&currentUptime<previousUptime)return{bps:null,status:'device_restart',stale:false,utilizationPercent:null};
  if(options.interfaceId&&previous.interfaceId&&current.interfaceId&&previous.interfaceId!==current.interfaceId)return{bps:null,status:'interface_replaced',stale:false,utilizationPercent:null};
  const delta=counterDelta(previous.bytes,current.bytes,options.counterBits);
  if(delta.delta===null)return{bps:null,status:delta.status,stale:false,utilizationPercent:null};
  const elapsedSeconds=(currentAt-previousAt)/1000,bps=Number(delta.delta)*8/elapsedSeconds;
  if(!Number.isFinite(bps)||bps<0)return{bps:null,status:'invalid_rate',stale:false,utilizationPercent:null};
  const staleAfterMs=finiteNumber(options.staleAfterMs)??Math.max(60000,(currentAt-previousAt)*3),now=finiteNumber(options.now)??Date.now(),stale=now-currentAt>staleAfterMs;
  const speedBps=finiteNumber(current.speedBps??options.speedBps),tolerance=finiteNumber(options.utilizationTolerance)??1.2,utilizationPercent=speedBps&&speedBps>0?bps/speedBps*100:null;
  const speedChanged=finiteNumber(previous.speedBps)!==null&&speedBps!==null&&finiteNumber(previous.speedBps)!==speedBps;
  if(utilizationPercent!==null&&utilizationPercent>100*tolerance&&!speedChanged)return{bps:null,status:'implausible_rate',stale,utilizationPercent};
  return{bps,status:stale?'stale':delta.status,stale,utilizationPercent};
}

class NetworkMetricNormalizer{
  constructor(options={}){this.options=options;this.baselines=new Map();}
  reset(interfaceId){if(interfaceId)this.baselines.delete(interfaceId);else this.baselines.clear();}
  normalize(sample){
    const interfaceId=String(sample?.interfaceId||'');
    if(!interfaceId)return{...sample,rates:null,status:'invalid_interface'};
    const previous=this.baselines.get(interfaceId),common={...this.options,...sample.options,interfaceId};
    const rx=calculateCounterRate(previous&&{...previous,bytes:previous.rxBytes},sample&&{...sample,bytes:sample.rxBytes},common);
    const tx=calculateCounterRate(previous&&{...previous,bytes:previous.txBytes},sample&&{...sample,bytes:sample.txBytes},common);
    this.baselines.set(interfaceId,{...sample});
    return{...sample,rates:{rxBps:rx.bps,txBps:tx.bps,rxUtilizationPercent:rx.utilizationPercent,txUtilizationPercent:tx.utilizationPercent},display:{rx:formatNetworkRate(rx.bps),tx:formatNetworkRate(tx.bps),speed:formatNetworkRate(sample.speedBps)},status:rx.status===tx.status?rx.status:`rx:${rx.status};tx:${tx.status}`,stale:rx.stale||tx.stale};
  }
}

module.exports={NetworkMetricNormalizer,calculateCounterRate,counterDelta,formatNetworkRate,formatStorageSize,formatPacketRate};
