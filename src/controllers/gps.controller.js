// src/controllers/gps.controller.js

async function updateLocation(req, res, next) {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const { latitude, longitude, accuracy, altitude, speed, heading, battery, deviceTimestamp, permissionStatus = 'GRANTED' } = req.body;

        if (latitude === undefined || longitude === undefined) {
            return res.status(400).json({ success: false, error: 'latitude and longitude are required' });
        }

        const lat = Number(latitude);
        const lng = Number(longitude);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
            return res.status(400).json({ success: false, error: 'Invalid latitude or longitude' });
        }
        const retentionDays = Math.min(365, Math.max(1, Number(process.env.GPS_RETENTION_DAYS || 30)));
        const location = await req.prisma.$transaction(async tx => {
          const created = await tx.userGPSLocation.create({
            data: {
                userId,
                latitude: lat,
                longitude: lng,
                accuracy: accuracy !== undefined ? Number(accuracy) : null,
                altitude: altitude !== undefined ? Number(altitude) : null,
                speed: speed !== undefined ? Number(speed) : null,
                heading: heading !== undefined ? Number(heading) : null,
                battery: battery !== undefined ? Number(battery) : null,
                deviceTimestamp: deviceTimestamp ? new Date(deviceTimestamp) : null,
                receivedAt: new Date(),
                permissionStatus: String(permissionStatus).slice(0, 32),
                timestamp: new Date()
            }
          });
          await tx.userGPSLocation.deleteMany({ where: {
            userId,
            timestamp: { lt: new Date(Date.now() - retentionDays * 86_400_000) },
          } });
          return created;
        });

        const wsManager = req.app.get('webSocketManager');
        if (wsManager) {
            wsManager.emitEvent('gps.location.updated', {
                ispId: req.user.ispId,
                branchId: req.user.branchId,
                resellerId: req.user.resellerId,
                userId,
                latestLocation: location
            });
        }

        return res.json({ success: true, data: location });
    } catch (err) {
        return next(err);
    }
}

async function getFieldStaffLocations(req, res, next) {
    try {
        const ispId = Number(req.ispId);

        // Get latest location for each active user in this ISP
        const users = await req.prisma.user.findMany({
            where: {
                ispId, isDeleted: false, status: 'active',
                ...(req.branchId ? { branchId: req.branchId } : {}),
                ...(req.user?.resellerId ? { resellerId: req.user.resellerId } : {}),
                role: {
                    is: {
                        OR: [
                            { name: { contains: 'Field Staff' } },
                            { name: { contains: 'field_staff' } },
                            { permissions: { some: { name: 'gps_submit_own' } } }
                        ]
                    }
                }
            },
            select: {
                id: true,
                name: true,
                email: true,
                role: { select: { name: true } },
                department: { select: { name: true } },
                gpsLocations: {
                    take: 1,
                    orderBy: { timestamp: 'desc' }
                }
            }
        });

        const staleAfterMs = Math.max(60_000, Number(process.env.GPS_STALE_AFTER_MS || 300_000));
        const activeStaff = users.map(u => {
            const latest = u.gpsLocations[0] || null;
            const ageMs = latest ? Date.now() - new Date(latest.receivedAt || latest.timestamp).getTime() : null;
            return {
                userId: u.id,
                name: u.name,
                email: u.email,
                role: u.role?.name || 'Staff',
                department: u.department?.name || 'N/A',
                latestLocation: latest,
                locationStatus: !latest ? 'unavailable' : latest.permissionStatus === 'DENIED' ? 'permission_denied' : ageMs > staleAfterMs ? 'stale' : 'current',
                ageSeconds: ageMs === null ? null : Math.max(0, Math.floor(ageMs / 1000)),
            };
        });

        return res.json({
            success: true,
            data: activeStaff,
            totalStaff: activeStaff.length,
            totalStaffWithLocation: activeStaff.filter(staff => staff.latestLocation).length
        });
    } catch (err) {
        return next(err);
    }
}

async function getLocationHistory(req, res, next) {
    try {
        const userId = Number(req.params.userId);
        const { limit = 100 } = req.query;

        const target = await req.prisma.user.findFirst({ where: {
            id: userId, ispId: Number(req.ispId), isDeleted: false,
            ...(req.branchId ? { branchId: req.branchId } : {}),
            ...(req.user?.resellerId ? { resellerId: req.user.resellerId } : {}),
        }, select: { id: true } });
        if (!target) return res.status(404).json({ success: false, error: 'Field staff user not found' });
        const history = await req.prisma.userGPSLocation.findMany({
            where: { userId: target.id },
            take: Math.min(1000, Math.max(1, Number(limit) || 100)),
            orderBy: { timestamp: 'desc' }
        });

        await req.prisma.auditLog.create({ data: {
            ispId: Number(req.ispId), branchId: req.branchId || null, userId: req.user.id,
            action: 'GPS_LOCATION_HISTORY_VIEWED', details: JSON.stringify({ targetUserId: target.id, records: history.length }), ip: req.ip,
        } }).catch(() => {});

        return res.json({ success: true, data: history });
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    updateLocation,
    getFieldStaffLocations,
    getLocationHistory
};
