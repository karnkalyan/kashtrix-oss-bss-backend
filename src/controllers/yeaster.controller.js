const YeastarService = require('../services/yeaster.service');

class YeastarController {
  constructor(prisma) {
    this.prisma = prisma;
    console.log('✅ YeastarController initialized with enhanced call APIs');
  }

  #formatCallLog(log) {
    const caller = log.caller || log.callerId || log.callfrom || '';
    const called = log.called || log.calledNumber || log.callto || '';
    const extension = log.extension || log.extensionNumber || log.extensionId || '';

    return {
      ...log,
      caller,
      called,
      callerId: caller || '-',
      calledNumber: called || '-',
      extension: extension ? String(extension) : '',
      channelId: log.channelid || log.channelId || '',
      callId: log.callid || log.callId || '',
      status: log.status || log.memberstatus || 'unknown',
      direction: log.direction || 'internal',
      startTime: log.startTime || log.createdAt,
      endTime: log.endTime || log.updatedAt,
      duration: log.duration || 0
    };
  }

  #formatActiveCall(call) {
    const caller = call.caller || call.callerId || '';
    const called = call.called || call.calledNumber || '';

    return {
      ...call,
      caller: caller || '-',
      called: called || '-',
      callerId: caller || '-',
      calledNumber: called || '-',
      channelId: call.channelid || call.channelId || '',
      callId: call.callid || call.callId || '',
      status: call.status || 'unknown',
      direction: call.direction || 'internal',
      startTime: call.startTime || call.createdAt,
      duration: call.duration || 0
    };
  }


  #handleServiceError(error, operation = 'operation') {
    console.error(`[YeastarController] ${operation} error:`, error);

    // Extract the enhanced error message if available
    let errorMessage = error.message;

    // Check for Yeastar API error format
    if (error.message.includes('Yeastar API Error')) {
      errorMessage = error.message;
    }

    return {
      success: false,
      error: errorMessage,
      message: `Failed to ${operation.replace('_', ' ')}`,
      timestamp: new Date().toISOString()
    };
  }

  #logAudit(userId, ispId, action, details) {
    this.prisma.serviceLog.create({
      data: {
        ispId,
        serviceCode: 'YEASTAR',
        operation: action,
        status: 'success',
        data: {
          userId,
          ...details
        }
      }
    }).catch((error) => {
      console.error('[YeastarController] Audit log error:', error);
    });
  }


  // ==================== STATUS & SYSTEM ====================
  async getDashboardStatus(req, res) {
    try {
      const ispId = req.ispId;
      const status = await YeastarService.getServiceStatus(ispId, this.prisma);

      res.json({
        success: true,
        ...status
      });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_status'));
    }
  }

  async getSystemInfo(req, res) {
    try {
      const ispId = req.ispId;
      const status = await YeastarService.getServiceStatus(ispId, this.prisma);
      if (!status?.configured) {
        return res.json({
          success: true,
          configured: false,
          status: 'Not Configured',
          message: 'Yeastar service not configured for ISP'
        });
      }
      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.getSystemInfo();
      res.json(result);
    } catch (error) {
      if (error?.message && error.message.includes('not configured')) {
        return res.json({
          success: true,
          configured: false,
          status: 'Not Configured',
          message: error.message
        });
      }
      res.status(500).json(this.#handleServiceError(error, 'get_system_info'));
    }
  }

  async syncSystemStatus(req, res) {
    try {
      const ispId = req.ispId;
      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.syncSystemStatus();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async testConnection(req, res) {
    try {
      const ispId = req.ispId;
      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.testConnection();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        message: 'Connection test failed'
      });
    }
  }

  // ==================== EXTENSION MANAGEMENT ====================
  async listExtensions(req, res) {
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const ispId = req.ispId;
      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.listExtensions();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getExtensionsFromDB(req, res) {
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const ispId = req.ispId;

      const service = await YeastarService.create(ispId, this.prisma);
      const syncResult = await service.listExtensions();

      let extensions = await this.prisma.yeastarExtension.findMany({
        where: {
          ispId,
          isActive: true,
          isDeleted: false
        },
        orderBy: { extensionNumber: 'asc' }
      });

      const formattedExtensions = extensions.map((extension) => ({
        ...extension,
        number: extension.extensionNumber,
        username: extension.extensionName || extension.extensionNumber,
        type: extension.extensionType || 'SIP',
        status: extension.status || 'unknown',
        registered: String(extension.status || '').toLowerCase() === 'registered'
      }));

      res.json({
        success: true,
        data: formattedExtensions,
        total: formattedExtensions.length,
        message: syncResult.success
          ? `${formattedExtensions.length} extensions synced from PBX`
          : `${formattedExtensions.length} extensions found in database; live sync failed: ${syncResult.error || 'unknown error'}`
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getExtensionDetails(req, res) {
    try {
      const ispId = req.ispId;
      const { number } = req.params;

      if (!number) {
        return res.status(400).json({
          success: false,
          error: 'Extension number is required'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.getExtension(number);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getExtensionStatus(req, res) {
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const ispId = req.ispId;
      const { number } = req.params;
      const service = await YeastarService.create(ispId, this.prisma);

      const extResult = await service.getExtension(number);
      const callResult = await service.getActiveCalls();

      const statusData = {
        ...extResult.data,
        activeCalls: callResult.data?.filter(call =>
          call.extension === number ||
          call.caller === number ||
          call.called === number
        ) || [],
        lastUpdated: new Date().toISOString()
      };

      res.json({
        success: true,
        data: statusData,
        message: `Status retrieved for extension ${number}`
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async addExtension(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;  // FIXED: Use req.user.id instead of req.userId
      const extensionData = req.body;

      if (!extensionData.number || !(extensionData.username || extensionData.extensionName) ||
        !extensionData.registerpassword) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: number, username or extensionName, registerpassword'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.addExtension(extensionData);

      if (result.success) {
        this.#logAudit(userId, ispId, 'extension_add', {
          extension: extensionData.number,
          username: extensionData.username || extensionData.extensionName,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async updateExtension(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;  // FIXED
      const extensionData = req.body;

      if (!extensionData.number) {
        return res.status(400).json({
          success: false,
          error: 'Extension number is required'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.updateExtension(extensionData);

      if (result.success) {
        this.#logAudit(userId, ispId, 'extension_update', {
          extension: extensionData.number,
          updatedFields: Object.keys(extensionData).filter(k => k !== 'number'),
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async deleteExtension(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;  // FIXED
      const { number } = req.body;

      if (!number) {
        return res.status(400).json({
          success: false,
          error: 'Extension number is required'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.deleteExtension(number);

      if (result.success) {
        this.#logAudit(userId, ispId, 'extension_delete', {
          extension: number,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // ==================== TRUNK MANAGEMENT ====================
  async listTrunks(req, res) {
    try {
      const ispId = req.ispId;
      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.listTrunks();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getTrunksFromDB(req, res) {
    try {
      const ispId = req.ispId;
      const trunks = await this.prisma.yeastarTrunk.findMany({
        where: {
          ispId,
          isActive: true,
          isDeleted: false
        },
        orderBy: { trunkname: 'asc' }
      });

      res.json({
        success: true,
        data: trunks,
        total: trunks.length,
        message: `${trunks.length} trunks found in database`
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getTrunkDetails(req, res) {
    try {
      const ispId = req.ispId;
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'Trunk ID is required'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.getTrunk(id);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async addTrunk(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;  // FIXED
      const trunkData = req.body;

      if (!trunkData.trunkname || !trunkData.trunktype) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: trunkname, trunktype'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.addTrunk(trunkData);

      if (result.success) {
        this.#logAudit(userId, ispId, 'trunk_add', {
          trunkname: trunkData.trunkname,
          trunktype: trunkData.trunktype,
          trunkId: result.data?.id,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async updateTrunk(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;  // FIXED
      const trunkData = req.body;

      if (!trunkData.id || !trunkData.trunktype) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: id, trunktype'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.updateTrunk(trunkData);

      if (result.success) {
        this.#logAudit(userId, ispId, 'trunk_update', {
          trunkId: trunkData.id,
          updatedFields: Object.keys(trunkData).filter(k => !['id', 'trunktype'].includes(k)),
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async deleteTrunk(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;  // FIXED
      const { id } = req.body;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'Trunk ID is required'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.deleteTrunk(id);

      if (result.success) {
        this.#logAudit(userId, ispId, 'trunk_delete', {
          trunkId: id,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // ==================== CALL MANAGEMENT ====================



  async makeCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const assignedExtension = String(req.user?.yeastarExt || req.user?.extId || req.extId || '').trim();

      const {
        dialpermission,
        autoanswer = 'no'
      } = req.body;

      const extensionVal = String(req.body.extension || '').trim() || assignedExtension;
      const callerVal = String(req.body.caller || '').trim() || extensionVal;
      const calleeVal = String(req.body.callee || req.body.number || '').trim();

      const callerNumber = callerVal;
      const calleeNumber = calleeVal;

      if (!assignedExtension) {
        return res.status(403).json({
          success: false,
          error: 'User does not have permission or registered extension',
          message: 'Please ask an administrator to assign a VoIP extension before making calls.'
        });
      }

      if (!callerNumber || !calleeNumber) {
        return res.status(400).json({
          success: false,
          error: 'Caller and callee numbers are required',
          message: 'Missing required parameters'
        });
      }

      if (callerNumber !== assignedExtension) {
        return res.status(403).json({
          success: false,
          error: 'You can only make calls from your assigned Yeastar extension.',
          message: `Your assigned extension is ${assignedExtension}.`
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.makeCall(callerNumber, calleeNumber, { dialpermission, autoanswer });

      if (result.success) {
        // Log audit
        this.#logAudit(userId, ispId, 'call_make', {
          extension: callerNumber,
          number: calleeNumber,
          dialpermission,
          autoanswer,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'make_call'));
    }
  }

  /**
   * Query detailed information about a specific call
   * GET /yeaster/calls/:callid
   */
  async queryCall(req, res) {
    try {
      const ispId = req.ispId;
      const { callid } = req.params;

      if (!callid) {
        return res.status(400).json({
          success: false,
          error: 'Call ID is required',
          message: 'Missing call ID parameter'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.queryCall(callid);

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'query_call'));
    }
  }

  /**
   * Park a call to a specific slot
   * POST /yeaster/calls/park
   */
  async parkCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid, slot = '' } = req.body;

      if (!channelid) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.parkCall(channelid, slot);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_park', {
          channelid,
          slot,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'park_call'));
    }
  }

  /**
   * Unpark a call from a slot
   * POST /yeaster/calls/unpark
   */
  async unparkCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { slot, extension = '' } = req.body;

      if (!slot) {
        return res.status(400).json({
          success: false,
          error: 'Park slot number is required',
          message: 'Missing slot parameter'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.unparkCall(slot, extension);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_unpark', {
          slot,
          extension,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'unpark_call'));
    }
  }

  /**
   * Barge into an active call (listen and speak)
   * POST /yeaster/calls/barge
   */
  async bargeCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid } = req.body;

      if (!channelid) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.bargeCall(channelid);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_barge', {
          channelid,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'barge_call'));
    }
  }

  /**
   * Whisper into an active call (listen only)
   * POST /yeaster/calls/whisper
   */
  async whisperCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid } = req.body;

      if (!channelid) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.whisperCall(channelid);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_whisper', {
          channelid,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'whisper_call'));
    }
  }

  async getCallParkStatus(req, res) {
    try {
      const ispId = req.ispId;
      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.getCallParkStatus();
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'callpark_status'));
    }
  }

  async acceptInboundCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const {
        channelid,
        channelId,
        channelids,
        extnumber,
        extension,
        cstacallid,
        cstaCallId,
        callid,
        callId,
        ipaddress,
        ipAddress
      } = req.body;
      const targetCallId = String(callid || callId || '').trim();
      const targetExtension = String(extnumber || extension || req.user.extId || req.user.yeastarExt || '').trim();
      const explicitUacstaCall = targetExtension && (cstacallid || cstaCallId) && (ipaddress || ipAddress)
        ? {
            extnumber: targetExtension,
            cstacallid: cstacallid || cstaCallId,
            ipaddress: ipaddress || ipAddress
          }
        : null;
      const cachedUacstaCall = explicitUacstaCall || YeastarService.getLatestUacstaCall(ispId, targetExtension);
      const channelCandidates = [
        ...(Array.isArray(channelids) ? channelids : []),
        channelid,
        channelId
      ]
        .map(id => (id == null ? '' : String(id).trim()))
        .filter(Boolean);
      const uniqueChannelIds = [...new Set(channelCandidates)];

      if (!cachedUacstaCall && !uniqueChannelIds.length) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID or uaCSTA call information'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      let uacstaResult = null;
      if (cachedUacstaCall) {
        uacstaResult = await service.acceptUacstaInboundCall(cachedUacstaCall);
        if (!uacstaResult.success && /10103|channelid does not exist/i.test(String(uacstaResult.error || uacstaResult.message || ''))) {
          YeastarService.clearLatestUacstaCall(ispId, targetExtension);
        }

        if (uacstaResult.success) {
          this.#logAudit(userId, ispId, 'call_accept_uacsta_inbound', {
            extnumber: cachedUacstaCall.extnumber,
            cstacallid: cachedUacstaCall.cstacallid,
            ipaddress: cachedUacstaCall.ipaddress,
            result: uacstaResult.data,
            timestamp: new Date().toISOString()
          });

          return res.json({
            ...uacstaResult,
            remoteAnswered: true,
            acceptedBy: 'uacsta',
            uacsta: {
              extnumber: cachedUacstaCall.extnumber,
              cstacallid: cachedUacstaCall.cstacallid,
              ipaddress: cachedUacstaCall.ipaddress
            },
            attemptedChannelIds: uniqueChannelIds
          });
        }
      }

      let result = null;
      let acceptedChannelId = null;

      for (const candidate of uniqueChannelIds) {
        result = await service.acceptInboundCall(candidate);
        if (result.success) {
          acceptedChannelId = candidate;
          break;
        }
      }

      if (!result) {
        result = {
          success: false,
          error: 'Failed to accept inbound call',
          message: 'No channel IDs were available to try'
        };
      }

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_accept_inbound', {
          channelid: acceptedChannelId,
          attemptedChannelIds: uniqueChannelIds,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      const staleChannel = !result.success && /10103|channelid does not exist/i.test(String(result.error || result.message || ''));

      res.status(result.success ? 200 : staleChannel ? 410 : 400).json({
        ...result,
        callid: targetCallId || undefined,
        acceptedChannelId,
        attemptedChannelIds: uniqueChannelIds,
        remoteAnswered: false,
        acceptedBy: result.success ? 'inbound_control' : null,
        requiresUaCsta: result.success,
        staleChannel,
        uacstaAvailable: Boolean(cachedUacstaCall),
        uacstaError: uacstaResult && !uacstaResult.success ? uacstaResult.error : null,
        uacstaAttempt: cachedUacstaCall
          ? {
              extnumber: cachedUacstaCall.extnumber,
              cstacallid: cachedUacstaCall.cstacallid,
              ipaddress: cachedUacstaCall.ipaddress,
              ageMs: Date.now() - cachedUacstaCall.receivedAt
            }
          : null,
        message: result.success
          ? (uacstaResult && !uacstaResult.success
              ? 'Inbound route accepted by PBX, but uaCSTA remote answer failed. Make sure PBX and phone uaCSTA are enabled and click Receive while the extension is still ringing.'
              : 'Inbound route accepted by PBX, but no uaCSTA ringing event was available to remotely answer the extension. Enable uaCSTA on PBX and phone to answer from the inquiry dashboard.')
          : staleChannel
            ? 'This call already ended or the PBX channel expired. Receive is only available while the extension is actively ringing.'
            : result.message
      });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'accept_inbound_call'));
    }
  }

  async refuseInboundCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid, channelId } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.refuseInboundCall(targetChannelId);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_refuse_inbound', {
          channelid: targetChannelId,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'refuse_inbound_call'));
    }
  }

  async muteCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid, channelId } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.muteCall(targetChannelId);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_mute', {
          channelid: targetChannelId,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'mute_call'));
    }
  }

  async unmuteCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid, channelId } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.unmuteCall(targetChannelId);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_unmute', {
          channelid: targetChannelId,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'unmute_call'));
    }
  }

  async addCallMember(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid, channelId, number, dialpermission } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId || !number) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID and number are required',
          message: 'Missing required parameters'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.addCallMember(targetChannelId, number, dialpermission);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_add_member', {
          channelid: targetChannelId,
          number,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'add_call_member'));
    }
  }

  async playPrompt(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid, channelId, prompt, interrupt } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId || !prompt) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID and prompt are required',
          message: 'Missing required parameters'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.playPrompt(targetChannelId, prompt, interrupt);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_play_prompt', {
          channelid: targetChannelId,
          prompt,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'play_prompt'));
    }
  }

  async proxyApiRequest(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { action, endpoint, params = {}, method = 'POST' } = req.body;
      const requestedAction = String(action || endpoint || '').trim();
      const normalizedMethod = String(method || 'POST').toUpperCase();

      if (!requestedAction) {
        return res.status(400).json({
          success: false,
          error: 'Yeastar API action is required',
          message: 'Provide action like queue/query, companycontacts/add, voicemail/query'
        });
      }

      if (!['GET', 'POST'].includes(normalizedMethod)) {
        return res.status(400).json({
          success: false,
          error: 'Only GET and POST methods are supported for Yeastar API requests'
        });
      }

      const normalizedAction = requestedAction.replace(/^\/+|\/+$/g, '').toLowerCase();
      if (normalizedAction === 'login') {
        return res.status(400).json({
          success: false,
          error: 'Login is handled internally by the Yeastar service'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.apiRequest(requestedAction, params, normalizedMethod);

      if (result.success) {
        this.#logAudit(userId, ispId, 'yeastar_api_request', {
          action: requestedAction,
          method: normalizedMethod,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'yeastar_api_request'));
    }
  }

  /**
   * Monitor an extension call (listen, whisper, or barge)
   * POST /yeaster/calls/listen
   */
  async monitorCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { monitor, extension, type = 'listen' } = req.body;

      if (!monitor || !extension) {
        return res.status(400).json({
          success: false,
          error: 'Monitor and extension are required',
          message: 'Missing monitor or extension'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.monitorCall(monitor, extension, type);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_monitor', {
          monitor,
          extension,
          type,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'monitor_call'));
    }
  }

  /**
   * Start a conference call
   * POST /yeaster/calls/conference
   */
  async startConference(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { extension, participants = [] } = req.body;

      if (!extension || !participants.length) {
        return res.status(400).json({
          success: false,
          error: 'Extension and at least one participant are required',
          message: 'Missing required parameters'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.startConference(extension, participants);

      if (result.success) {
        this.#logAudit(userId, ispId, 'conference_start', {
          host: extension,
          participants: participants.length,
          conferenceId: result.data?.conferenceId,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'start_conference'));
    }
  }

  /**
   * Hang up a call
   * POST /yeaster/calls/hangup
   */
  async hangupCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid, channelId } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.hangupCall(targetChannelId);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_hangup', {
          channelid: targetChannelId,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'hangup_call'));
    }
  }

  /**
   * Query call status (single call or all)
   * GET /yeaster/calls/status
   */
  async queryCallStatus(req, res) {
    try {
      const ispId = req.ispId;
      const { callid, extension, type = 'all' } = req.query;

      const service = await YeastarService.create(ispId, this.prisma);

      if (callid) {
        // Query specific call
        const result = await service.queryCall(callid);
        res.json(result);
      } else if (extension) {
        // Query calls for specific extension
        const activeCalls = await service.getActiveCalls();
        const extensionCalls = activeCalls.data?.filter(call =>
          call.extension === extension ||
          call.caller === extension ||
          call.called === extension
        ) || [];

        res.json({
          success: true,
          data: extensionCalls,
          total: extensionCalls.length,
          message: `${extensionCalls.length} calls found for extension ${extension}`
        });
      } else {
        // Get all active calls
        const result = await service.getActiveCalls();
        res.json(result);
      }
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'query_call_status'));
    }
  }

  /**
   * Get call logs with filters
   * GET /yeaster/calls/logs
   */
  async getCallLogs(req, res) {
    try {
      const ispId = req.ispId;
      const {
        startDate,
        endDate,
        extension,
        direction,
        status,
        limit = 100,
        page = 1
      } = req.query;

      const service = await YeastarService.create(ispId, this.prisma);

      const logs = await service.getCallLogs(
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined,
        parseInt(limit)
      );

      // Apply additional filters if provided
      let filteredLogs = logs.data || [];

      if (extension) {
        filteredLogs = filteredLogs.filter(log =>
          log.caller === extension ||
          log.called === extension ||
          log.extension === extension
        );
      }

      if (direction) {
        filteredLogs = filteredLogs.filter(log => log.direction === direction);
      }

      if (status) {
        filteredLogs = filteredLogs.filter(log => log.status === status);
      }

      // Pagination
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + parseInt(limit);
      const paginatedLogs = filteredLogs.slice(startIndex, endIndex).map(log => this.#formatCallLog(log));

      res.json({
        success: true,
        data: paginatedLogs,
        total: filteredLogs.length,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(filteredLogs.length / limit),
        message: `${paginatedLogs.length} call logs found`
      });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_call_logs'));
    }
  }

  /* ========== EXISTING CALL CONTROL APIS (UPDATED WITH ERROR HANDLING) ========== */

  async holdCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid, channelId } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.holdCall(targetChannelId);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_hold', {
          channelid: targetChannelId,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'hold_call'));
    }
  }

  async unholdCall(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;
      const { channelid, channelId } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID is required',
          message: 'Missing channel ID'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.unholdCall(targetChannelId);

      if (result.success) {
        this.#logAudit(userId, ispId, 'call_unhold', {
          channelid: targetChannelId,
          result: result.data,
          timestamp: new Date().toISOString()
        });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'unhold_call'));
    }
  }





  async getActiveCalls(req, res) {
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const ispId = req.ispId;
      const number = req.query.number || 'all';
      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.getActiveCalls(number);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async saveActiveCallNote(req, res) {
    try {
      const ispId = req.ispId;
      const { callid, note } = req.body;

      if (!callid) {
        return res.status(400).json({
          success: false,
          error: 'Call ID is required'
        });
      }

      const activeCall = await this.prisma.yeastarActiveCall.upsert({
        where: { callid },
        update: { note },
        create: {
          ispId,
          callid,
          channelid: '',
          status: 'active',
          note
        }
      });

      res.json({
        success: true,
        data: activeCall
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getMyExtensionCallStatus(req, res) {
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const ispId = req.ispId;
      const assignedExtension = String(req.user?.yeastarExt || req.user?.extId || req.extId || '').trim();

      if (!assignedExtension) {
        return res.status(403).json({
          success: false,
          error: 'No Yeastar extension is assigned to your user account.',
          data: { status: 'Failed', calllist: [] },
          total: 0
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.getExtensionCallStatus(assignedExtension);

      if (result.success && result.data && Array.isArray(result.data.calllist)) {
        const callIds = [];
        result.data.calllist.forEach(ext => {
          if (Array.isArray(ext.numbercalls)) {
            ext.numbercalls.forEach(call => {
              if (call.callid) callIds.push(call.callid);
            });
          }
        });

        if (callIds.length > 0) {
          const dbCalls = await this.prisma.yeastarActiveCall.findMany({
            where: { callid: { in: callIds } },
            select: { callid: true, note: true }
          });
          const noteMap = {};
          dbCalls.forEach(c => {
            noteMap[c.callid] = c.note;
          });

          result.data.calllist = result.data.calllist.map(ext => ({
            ...ext,
            numbercalls: ext.numbercalls.map(call => ({
              ...call,
              note: noteMap[call.callid] || ''
            }))
          }));
        }
      }

      res.json({
        ...result,
        assignedExtension
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        data: { status: 'Failed', calllist: [] },
        total: 0
      });
    }
  }

  async getActiveCallsFromDB(req, res) {
    try {
      const ispId = req.ispId;
      const activeCalls = await this.prisma.yeastarActiveCall.findMany({
        where: {
          ispId,
          isActive: true
        },
        orderBy: { startTime: 'desc' }
      });

      res.json({
        success: true,
        data: activeCalls.map(call => this.#formatActiveCall(call)),
        total: activeCalls.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }


  async getCallDashboard(req, res) {
    try {
      const ispId = req.ispId;
      const service = await YeastarService.create(ispId, this.prisma);

      const [activeCalls, extensions, systemInfo, callLogs] = await Promise.all([
        service.getActiveCalls(),
        service.listExtensions(),
        service.getSystemInfo(),
        service.getCallLogs(
          new Date(new Date().setHours(0, 0, 0, 0)),
          new Date()
        )
      ]);

      const dashboard = {
        timestamp: new Date().toISOString(),
        system: systemInfo.data,
        extensions: {
          total: extensions.total || 0,
          active: extensions.data?.filter(e => e.registered).length || 0
        },
        activeCalls: {
          total: activeCalls.total || 0,
          inbound: activeCalls.data?.filter(c => c.direction === 'inbound').length || 0,
          outbound: activeCalls.data?.filter(c => c.direction === 'outbound').length || 0,
          internal: activeCalls.data?.filter(c => c.direction === 'internal').length || 0
        },
        todayStats: {
          total: callLogs.total || 0,
          answered: callLogs.data?.filter(l =>
            l.status === 'ANSWERED' || l.status === 'ANSWER'
          ).length || 0,
          missed: callLogs.data?.filter(l =>
            l.status === 'NOANSWER' || l.status === 'BUSY'
          ).length || 0,
          totalDuration: callLogs.data?.reduce((sum, log) => sum + (log.duration || 0), 0) || 0
        },
        listener: YeastarService.getListeners ? YeastarService.getListeners() : []
      };

      res.json({
        success: true,
        data: dashboard,
        message: 'Call dashboard generated'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async transferCall(req, res) {
    try {
      const ispId = req.ispId;
      const { channelId, channelid, number, dialpermission } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId || !number) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID and target number are required'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.transferCall(targetChannelId, number, dialpermission);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async attendedTransfer(req, res) {
    try {
      const ispId = req.ispId;
      const { channelId, channelid, tonumber, dialpermission } = req.body;
      const targetChannelId = channelid || channelId;

      if (!targetChannelId || !tonumber) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID and target number are required'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.attendedTransfer(targetChannelId, tonumber, dialpermission);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async attendedTransferOperate(req, res) {
    try {
      const ispId = req.ispId;
      const { channelId, operate } = req.body;

      if (!channelId || !operate) {
        return res.status(400).json({
          success: false,
          error: 'Channel ID and operation are required'
        });
      }

      const service = await YeastarService.create(ispId, this.prisma);
      const result = await service.attendedTransferOperate(channelId, operate);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // ==================== CALL LOGS & REPORTS ====================


  async getExtensionStats(req, res) {
    try {
      const ispId = req.ispId;
      const { period = 'today' } = req.query;

      const dateFilter = this.#getDateFilter(period);
      const callLogs = await this.prisma.yeastarCallLog.findMany({
        where: {
          ispId,
          startTime: dateFilter
        }
      });

      const extensions = await this.prisma.yeastarExtension.findMany({
        where: {
          ispId,
          isActive: true,
          isDeleted: false
        }
      });

      const stats = {
        timestamp: new Date().toISOString(),
        period,
        totalExtensions: extensions.length,
        extensionActivity: {},
        topCalledExtensions: [],
        topCallingExtensions: [],
        callSummary: {
          total: callLogs.length,
          inbound: callLogs.filter(l => l.direction === 'inbound').length,
          outbound: callLogs.filter(l => l.direction === 'outbound').length,
          internal: callLogs.filter(l => l.direction === 'internal').length,
          answered: callLogs.filter(l =>
            l.status === 'ANSWERED' || l.status === 'ANSWER').length,
          missed: callLogs.filter(l =>
            l.status === 'NOANSWER' || l.status === 'BUSY').length,
          totalDuration: callLogs.reduce((sum, log) => sum + (log.duration || 0), 0)
        }
      };

      // Calculate extension activity
      extensions.forEach(ext => {
        const extensionCalls = callLogs.filter(log =>
          log.callerId === ext.extensionNumber ||
          log.calledNumber === ext.extensionNumber ||
          log.extension === ext.extensionNumber
        );

        stats.extensionActivity[ext.extensionNumber] = {
          name: ext.extensionName,
          totalCalls: extensionCalls.length,
          inboundCalls: extensionCalls.filter(l =>
            l.direction === 'inbound' && l.calledNumber === ext.extensionNumber).length,
          outboundCalls: extensionCalls.filter(l =>
            l.direction === 'outbound' && l.callerId === ext.extensionNumber).length,
          totalDuration: extensionCalls.reduce((sum, log) => sum + (log.duration || 0), 0),
          status: ext.status
        };
      });

      // Calculate top extensions
      const calledCounts = {};
      const callingCounts = {};

      callLogs.forEach(log => {
        if (log.calledNumber && log.calledNumber.length <= 7) {
          calledCounts[log.calledNumber] = (calledCounts[log.calledNumber] || 0) + 1;
        }
        if (log.callerId && log.callerId.length <= 7) {
          callingCounts[log.callerId] = (callingCounts[log.callerId] || 0) + 1;
        }
      });

      stats.topCalledExtensions = Object.entries(calledCounts)
        .map(([ext, count]) => ({ extension: ext, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      stats.topCallingExtensions = Object.entries(callingCounts)
        .map(([ext, count]) => ({ extension: ext, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      res.json({
        success: true,
        data: stats,
        message: 'Extension statistics retrieved'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  #getDateFilter(period) {
    const now = new Date();
    let startDate = new Date();

    switch (period) {
      case 'today':
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'yesterday':
        startDate.setDate(now.getDate() - 1);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(startDate);
        endDate.setHours(23, 59, 59, 999);
        return {
          gte: startDate,
          lte: endDate
        };
      case 'week':
        startDate.setDate(now.getDate() - 7);
        break;
      case 'month':
        startDate.setMonth(now.getMonth() - 1);
        break;
      case 'year':
        startDate.setFullYear(now.getFullYear() - 1);
        break;
      default:
        return {};
    }

    return { gte: startDate };
  }

  // ==================== LISTENER MANAGEMENT ====================
  async startListener(req, res) {
    try {
      const ispId = req.ispId;
      console.log(`[YeastarController] Starting listener for ISP ${ispId}`);

      // Just call startListener - it will handle duplicates
      const result = await YeastarService.startListener(ispId, this.prisma);

      res.json(result);
    } catch (error) {
      console.error('[YeastarController] startListener error:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        message: 'Failed to start listener'
      });
    }
  }

  async stopListener(req, res) {
    try {
      const ispId = req.ispId;
      const result = YeastarService.stopListener(ispId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getListeners(req, res) {
    try {
      const listeners = YeastarService.getListeners();
      res.json({
        success: true,
        data: listeners,
        total: listeners.length
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getListenerEvents(req, res) {
    try {
      const ispId = req.ispId;
      const { limit = 50 } = req.query;
      const result = YeastarService.getListenerEvents(ispId, parseInt(limit));
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // ==================== BULK OPERATIONS ====================
  async syncAllData(req, res) {
    try {
      const ispId = req.ispId;
      const userId = req.user.id;  // FIXED
      const service = await YeastarService.create(ispId, this.prisma);

      // Sync all data in parallel
      const [extensions, trunks, systemStatus] = await Promise.all([
        service.listExtensions(),
        service.listTrunks(),
        service.syncSystemStatus()
      ]);

      this.#logAudit(userId, ispId, 'sync_all', {
        extensions: extensions.total,
        trunks: trunks.total,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        data: {
          extensions: extensions.total,
          trunks: trunks.total,
          systemStatus: systemStatus.success ? 'online' : 'offline'
        },
        message: 'All data synced successfully'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // ==================== HEALTH CHECK ====================
  async healthCheck(req, res) {
    try {
      const ispId = req.ispId;
      const service = await YeastarService.create(ispId, this.prisma);

      const checks = await Promise.allSettled([
        service.testConnection(),
        service.getSystemInfo(),
        service.getActiveCalls()
      ]);

      const results = checks.map((check, index) => ({
        check: ['connection', 'system', 'calls'][index],
        status: check.status,
        value: check.status === 'fulfilled' ? check.value : check.reason.message
      }));

      const allHealthy = results.every(r => r.status === 'fulfilled');

      res.json({
        success: true,
        healthy: allHealthy,
        checks: results,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
}

module.exports = YeastarController;
