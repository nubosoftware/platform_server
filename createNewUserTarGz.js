var async = require("async");
var ThreadedLogger = require('./ThreadedLogger.js');
var Platform = require('./platform.js');

var NEW_USER_TAR = 'new_user.tar.gz';

function create(req, res) {
    var logger = new ThreadedLogger();
    var platform = new Platform(logger);
    var localid;

    async.series([
        // Separate into 2 commands because the tar happens sometimes before directories are created
        // First ssh command
        function(callback) {
            var cmd = 'pm create-user createDirUser';
            platform.exec(cmd, function(err, code, signal, sshout) {
                if (err) {
                    var msg = 'ERROR:: cannot connect to platform ' + err;
                    callback(msg);
                    return;
                } else {
                    var re = new RegExp('Success: created user id ([0-9]+)');
                    var m = re.exec(sshout);
                    if (m) {
                        localid = m[1];
                        logger.info('Tempate user number ' + localid);
                        callback(null);
                    } else {
                        callback("Error with PM - cannot get localid");
                    }
                }

            });
        },
        function(callback) {
            var cmd = 'mkdir -p /data/user/' + localid + '/system/media' +
                '; chown system.system /data/user/' + localid + '/system';
            platform.exec(cmd, function(err, code, signal, exec_sshout) {
                if (err) {
                    var msg = 'ERROR:: cannot connect to platform ' + err;
                    callback(msg);
                    return;
                } else {
                    callback(null);
                }

            });
        },
        // Second ssh command
        function(callback) {
            var cmd = 'cd /data/user/' + localid + '; /system/xbin/tar -czf /data/tmp/' + NEW_USER_TAR + ' ./' +
                '; cp /data/system/packages.list /data/tmp/' +
                '; pm remove-user ' + localid +
                '; rm -rf /data/user/' + localid +
                '; rm -rf /data/system/users/' + localid +
                '; rm -rf /data/system/users/' + localid + '.xml';
            logger.info('cmd: ' + cmd);
            platform.exec(cmd, function(err, code, signal, exec_sshout) {
                logger.info('exec_sshout: ' + exec_sshout);
                if (err) {
                    var msg = 'ERROR:: cannot connect to platform ' + err;
                    callback(msg);
                    return;
                } else {
                    callback(null);
                    return;
                }

            });
        }
    ], function(err) {
        if (err) {
            var resobj = {
                status: 0,
                error: err
            };
            res.send(resobj);
            return;
        }

        var resobj = {
            status: 1,
            error: "created successfully"
        };
        res.send(resobj);
    });
}

module.exports = {
    create: create
}