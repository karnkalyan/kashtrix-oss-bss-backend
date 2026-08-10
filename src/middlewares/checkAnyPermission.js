module.exports = function checkAnyPermission(permissionNames = []) {
    return (req, res, next) => {
        if (!req.user || !Array.isArray(req.user.permissions)) {
            return res.status(403).json({ message: 'Access denied: User authentication incomplete or invalid' });
        }

        const role = req.user.role?.toLowerCase() || '';
        if (role === 'administrator' || role === 'super admin' || role === 'super_admin' || role === 'admin') {
            return next();
        }

        const hasPermission = permissionNames.some(permission => req.user.permissions.includes(permission));
        if (!hasPermission) {
            return res.status(403).json({ message: 'Access Denied' });
        }

        next();
    };
};
