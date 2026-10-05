const { EventEmitter } = require('events');

/**
 * AsteriskListenerService
 * Manages the persistent AMI event listener for an ISP tenant.
 * - Subscribes to raw AMI events
 * - Normalizes call lifecycle (start, ringing, answered, hungup)
 * - Broadcasts events through global.wsManager rooms: isp_<ispId>, asterisk_calls, etc.
 * - Records active call events and syncs into DB
 */
class AsteriskListenerService extends EventEmitter {
  #ispId = null;
  #amiClient = null;
  #prisma = null;
  #status = 'inactive';
  #startedAt = null;
  #lastEventAt = null;
  #reconnectCount = 0;
  #eventsBuffer = [];
  #lastError = null;

  constructor(ispId, amiClient, prisma) {
    super();
    this.#ispId = ispId;
    this.#amiClient = amiClient;
    this.#prisma = prisma;
    this.setMaxListeners(50);
  }

  get status() {
    return this.#status;
  }

  get isConnected() {
    return this.#amiClient ? this.#amiClient.isConnected && this.#amiClient.isAuthenticated : false;
  }

  get startedAt() {
    return this.#startedAt;
  }

  get lastEventAt() {
    return this.#lastEventAt;
  }

  get reconnectCount() {
    return this.#reconnectCount;
  }

  get events() {
    return this.#eventsBuffer;
  }

  get lastError() {
    return this.#lastError;
  }

  async start() {
    if (this.#status === 'active' && this.isConnected) {
      return { success: true, message: 'Asterisk listener already running', status: this.#status };
    }

    this.#status = 'connecting';
    this.#startedAt = Date.now();

    try {
      await this.#amiClient.connect();
      this.#status = 'active';
      this.#attachListeners();

      this.#broadcast('asterisk.listener.started', {
        ispId: this.#ispId,
        startedAt: this.#startedAt,
        status: 'active'
      });

      return {
        success: true,
        message: 'Asterisk event listener started successfully',
        ispId: this.#ispId,
        status: this.#status
      };
    } catch (err) {
      this.#status = 'error';
      this.#lastError = err.message;
      return {
        success: false,
        error: err.message,
        message: 'Failed to start Asterisk listener'
      };
    }
  }

  stop() {
    this.#status = 'stopped';
    if (this.#amiClient) {
      this.#amiClient.disconnect();
    }
    this.#broadcast('asterisk.listener.stopped', {
      ispId: this.#ispId,
      stoppedAt: Date.now(),
      status: 'stopped'
    });
    return { success: true, message: 'Asterisk listener stopped' };
  }

  #attachListeners() {
    this.#amiClient.removeAllListeners('event');
    this.#amiClient.removeAllListeners('disconnected');

    this.#amiClient.on('event', async (rawEvent) => {
      this.#lastEventAt = new Date().toISOString();
      this.#eventsBuffer.push({
        raw: rawEvent,
        receivedAt: this.#lastEventAt
      });
      if (this.#eventsBuffer.length > 200) {
        this.#eventsBuffer = this.#eventsBuffer.slice(-200);
      }

      await this.#processAmiEvent(rawEvent);
    });

    this.#amiClient.on('disconnected', () => {
      this.#reconnectCount++;
      this.#status = 'reconnecting';
    });

    this.#amiClient.on('authenticated', () => {
      this.#status = 'active';
    });
  }

  async #processAmiEvent(event) {
    const eventName = event.Event;
    if (!eventName) return;

    const lower = eventName.toLowerCase();
    const eventPayload = {
      ispId: this.#ispId,
      eventType: eventName,
      data: event,
      timestamp: new Date().toISOString()
    };

    // 1. WebSocket Broadcast to project rooms
    this.#broadcast('asterisk.event', eventPayload);

    // 2. Call lifecycle tracking
    if (lower === 'newchannel') {
      const channel = event.Channel;
      const callerId = event.CallerIDNum || event.CallerID || '';
      const uniqueid = event.Uniqueid || event.Linkedid || channel;
      this.#broadcast('asterisk.call.start', {
        ispId: this.#ispId,
        channel,
        caller: callerId,
        uniqueid,
        status: 'Ringing'
      });
      await this.#upsertActiveCall(event, 'Ringing');
    } else if (lower === 'newstate') {
      const stateDesc = event.ChannelStateDesc || '';
      if (stateDesc.toLowerCase() === 'up') {
        this.#broadcast('asterisk.call.answered', {
          ispId: this.#ispId,
          channel: event.Channel,
          status: 'Up'
        });
        await this.#upsertActiveCall(event, 'Up');
      }
    } else if (lower === 'bridgeenter' || lower === 'bridge') {
      this.#broadcast('asterisk.call.connected', {
        ispId: this.#ispId,
        channel: event.Channel1 || event.Channel,
        channel2: event.Channel2,
        status: 'Connected'
      });
    } else if (lower === 'hangup') {
      const channel = event.Channel;
      const uniqueid = event.Uniqueid || channel;
      this.#broadcast('asterisk.call.end', {
        ispId: this.#ispId,
        channel,
        uniqueid,
        cause: event['Cause-txt'] || event.Cause
      });
      await this.#removeActiveCall(channel, uniqueid, event);
    } else if (lower === 'peerstatus' || lower === 'device_state_change') {
      this.#broadcast('asterisk.extension.updated', {
        ispId: this.#ispId,
        peer: event.Peer,
        status: event.PeerStatus || event.State
      });
    } else if (lower === 'registry') {
      this.#broadcast('asterisk.trunk.updated', {
        ispId: this.#ispId,
        channelType: event.ChannelType,
        username: event.Username,
        status: event.Status
      });
    }
  }

  async #upsertActiveCall(event, callStatus) {
    if (!this.#prisma) return;
    try {
      const channelid = event.Channel || `chan_${Date.now()}`;
      const uniqueid = event.Uniqueid || event.Linkedid || channelid;
      const caller = event.CallerIDNum || event.CallerID || event.ConnectedLineNum || '-';
      const called = event.Exten || event.ConnectedLineNum || '-';

      await this.#prisma.asteriskActiveCall.upsert({
        where: { callid: uniqueid },
        update: {
          channelid,
          status: callStatus,
          caller,
          called,
          updatedAt: new Date()
        },
        create: {
          ispId: this.#ispId,
          callid: uniqueid,
          channelid,
          caller,
          called,
          status: callStatus,
          direction: 'internal'
        }
      });
    } catch (err) {
      // Ignore active call upsert error
    }
  }

  async #removeActiveCall(channel, uniqueid, hangupEvent) {
    if (!this.#prisma) return;
    try {
      // 1. Delete from active calls
      const activeCall = await this.#prisma.asteriskActiveCall.findFirst({
        where: {
          ispId: this.#ispId,
          OR: [
            { callid: uniqueid },
            { channelid: channel }
          ]
        }
      });

      if (activeCall) {
        await this.#prisma.asteriskActiveCall.delete({
          where: { id: activeCall.id }
        }).catch(() => {});

        // 2. Write to AsteriskCallLog
        const durationSec = activeCall.startTime
          ? Math.max(0, Math.round((Date.now() - new Date(activeCall.startTime).getTime()) / 1000))
          : 0;

        await this.#prisma.asteriskCallLog.create({
          data: {
            ispId: this.#ispId,
            callid: activeCall.callid,
            channelid: activeCall.channelid,
            direction: activeCall.direction || 'internal',
            caller: activeCall.caller,
            called: activeCall.called,
            status: hangupEvent['Cause-txt'] || 'Completed',
            duration: durationSec,
            startTime: activeCall.startTime,
            endTime: new Date(),
            eventType: 'Hangup',
            eventData: hangupEvent
          }
        }).catch(() => {});
      }
    } catch (err) {
      // Ignore log cleanup error
    }
  }

  #broadcast(eventName, payload) {
    if (global.wsManager) {
      const roomName = `isp_${this.#ispId}`;
      const topics = [
        roomName,
        'asterisk_calls',
        'asterisk_extensions',
        'asterisk_trunks',
        'asterisk_monitoring'
      ];

      topics.forEach((topic) => {
        if (typeof global.wsManager.broadcastToRoom === 'function') {
          global.wsManager.broadcastToRoom(topic, eventName, payload);
        } else if (typeof global.wsManager.emitEvent === 'function') {
          global.wsManager.emitEvent(eventName, payload);
        }
      });
    }
  }
}

module.exports = AsteriskListenerService;
