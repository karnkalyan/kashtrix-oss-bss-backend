const test=require('node:test');
const assert=require('node:assert/strict');
const {NetworkMetricNormalizer,calculateCounterRate,formatNetworkRate,formatStorageSize,formatPacketRate}=require('../src/services/metrics/NetworkMetricNormalizer');

test('network rates use decimal bit-per-second units',()=>{
  assert.equal(formatNetworkRate(850),'850 bps');
  assert.equal(formatNetworkRate(15400),'15.4 kbps');
  assert.equal(formatNetworkRate(2540000),'2.54 Mbps');
  assert.equal(formatNetworkRate(1200000000),'1.2 Gbps');
  assert.equal(formatNetworkRate(2e12),'2 Tbps');
});

test('storage uses binary units and packet rates stay distinct',()=>{
  assert.equal(formatStorageSize(1024),'1 KiB');
  assert.equal(formatStorageSize(1024**2),'1 MiB');
  assert.equal(formatStorageSize(1024**3),'1 GiB');
  assert.equal(formatPacketRate(1500),'1.5k pps');
});

test('byte counter deltas convert to bits per second and utilization',()=>{
  const result=calculateCounterRate({bytes:1000,timestamp:1000},{bytes:3500,timestamp:3000,speedBps:100000},{now:3000});
  assert.equal(result.bps,10000);
  assert.equal(result.utilizationPercent,10);
});

test('first sample is pending and never fabricates zero traffic',()=>{
  assert.deepEqual(calculateCounterRate(null,{bytes:100,timestamp:1000}),{bps:null,status:'pending',stale:false,utilizationPercent:null});
});

test('32-bit and 64-bit counter rollover are handled without negative rates',()=>{
  const rolled32=calculateCounterRate({bytes:4294967290,timestamp:0},{bytes:10,timestamp:1000},{counterBits:32,now:1000});
  assert.equal(rolled32.bps,128);
  assert.equal(rolled32.status,'rollover');
  const max64=(1n<<64n)-1n,rolled64=calculateCounterRate({bytes:max64-4n,timestamp:0},{bytes:5n,timestamp:1000},{counterBits:64,now:1000});
  assert.equal(rolled64.bps,80);
  assert.equal(rolled64.status,'rollover');
});

test('restart, reset, duplicate timestamp, and impossible utilization reset the rate',()=>{
  assert.equal(calculateCounterRate({bytes:1000,timestamp:0,uptimeSeconds:50},{bytes:10,timestamp:1000,uptimeSeconds:2}).status,'device_restart');
  assert.equal(calculateCounterRate({bytes:1000,timestamp:0},{bytes:10,timestamp:1000}).status,'counter_reset');
  assert.equal(calculateCounterRate({bytes:1000,timestamp:1000},{bytes:2000,timestamp:1000}).status,'invalid_timestamp');
  assert.equal(calculateCounterRate({bytes:0,timestamp:0},{bytes:100000,timestamp:1000,speedBps:1000}).status,'implausible_rate');
});

test('normalizer preserves raw counters, marks stale samples, and resets baselines',()=>{
  const normalizer=new NetworkMetricNormalizer({counterBits:64,now:100000,staleAfterMs:5000});
  const first=normalizer.normalize({interfaceId:'gi1/0/1',timestamp:1000,rxBytes:1000,txBytes:2000,speedBps:1000000});
  assert.equal(first.rates.rxBps,null);
  const second=normalizer.normalize({interfaceId:'gi1/0/1',timestamp:2000,rxBytes:2000,txBytes:3000,speedBps:1000000});
  assert.equal(second.rxBytes,2000);
  assert.equal(second.rates.rxBps,8000);
  assert.equal(second.stale,true);
  normalizer.reset('gi1/0/1');
  assert.equal(normalizer.normalize({interfaceId:'gi1/0/1',timestamp:3000,rxBytes:3000,txBytes:4000}).status,'pending');
});
