"use strict";

var async = require('async');
var http = require('./http.js');
var exec = require('child_process').exec;
var ThreadedLogger = require('./ThreadedLogger.js');
var Platform = require('./platform.js');


var flagInitAndroidStatus = 0; // 0: not yet done, 1: in progress, 2: done

module.exports = {
    startPlatformGet: startPlatformGet,
    startPlatformPost: startPlatformPost,
    killPlatform: killPlatform,
    checkPlatformStatus: checkPlatformStatus
};

function startPlatformGet(req, res) {
    var resobj = {
        status: 1,
        androidStatus: flagInitAndroidStatus
    };
    res.end(JSON.stringify(resobj, null, 2));
}

function startPlatformPost(req, res) {
    var logger = new ThreadedLogger();
    var reqestObj;
    var requestInProgress = true;

    if (flagInitAndroidStatus > 0) {
        var resobj = {status: 0};
        if (flagInitAndroidStatus === 1) resobj.msg = "Init Android OS in progress";
        if (flagInitAndroidStatus === 2) resobj.msg = "Init Android OS already done";
        res.end(JSON.stringify(resobj, null, 2));
        return;
    }
    flagInitAndroidStatus = 1;
    var requestKeepAliveInterval = setInterval(
        function() {
            res.writeContinue();
        },
        1000
    );

    logger.logTime("Start process request startPlatform");
    async.waterfall(
        [
        //get data from post request
        function(callback) {
            http.getObjFromRequest(req, function(err, obj) {
                callback(err, obj);
            });
        },
        function(obj, callback) {
            var res = validateStartPlatformRequest(obj);
            if (res) {
                reqestObj = obj;
                callback(null);
            } else {
                callback("Bad request");
            }
        },
        function(callback) {
            logger.info("preset platform parameters");
            setParametersOnMachine(reqestObj, logger, callback);
        },
        function(callback) {
            logger.info("init android");
            initAndroid(reqestObj, logger, callback);
        },
        function(callback) {
            logger.info("post boot procedures");
            afterInitAndroid(reqestObj, logger, callback);
        }
    ], function(err) {
        clearInterval(requestKeepAliveInterval);
        var resobj = {};
        if (err) {
            resobj.status = 0;
            resobj.msg = err;
            flagInitAndroidStatus = 3;
        } else {
            resobj.status = 1;
            flagInitAndroidStatus = 2;
        }
        res.end(JSON.stringify(resobj, null, 2));
        logger.logTime("Finish process request startPlatform");
    });
}

var validateStartPlatformRequest = function(obj) {
    return true;
};

function killPlatform(req, res) {
    var resobj;
    resobj.status = 0;
    resobj.msg = "Not implemented";
    res.end(JSON.stringify(resobj, null, 2));
}

var setParametersOnMachine = function(obj, logger, callback) {
    var sed_replacer = function(key, value) {
        return "sed \"s,\\(^" + key + "=\\).*,\\1" + value + ",\" -i /opt/Android/init-files.sh";
    };
    async.series(
        [
        function(callback) {
            var cmd = "";
            if (obj.platid) {
                cmd += sed_replacer("PlatformID", obj.platid) + " && ";
            }
            if (obj.gateway) {
                cmd += sed_replacer("GatewayURL", obj.gateway.internal_ip) + " && ";
            }
            if (obj.management) {
                var url = obj.management.url;
                var re = new RegExp('http[s]?://([^/]*)/?');
                var m = re.exec(url);
                cmd += sed_replacer("ManagementURL", url) + " && ";
                cmd += sed_replacer("ManagementHostName", m[1]) + " && ";
            }
            if (obj.nfs) {
                cmd += sed_replacer("NFSPREF", obj.nfs.nfs_ip + ":" + obj.nfs.nfs_path) + " && ";
            }
            cmd += "true";
            exec(cmd, function(error, stdout, stderr) {
                if (error) {
                    logger.error("cmd: " + cmd);
                    logger.error("error: " + JSON.stringify(error, null, 2));
                    logger.error("stdout: " + stdout);
                    logger.error("stderr: " + stderr);
                }
                callback(error);
            });
        }
    ], function(err) {
        callback(err);
        }
    );
};

var initAndroid = function(reqestObj, logger, callback) {
    var cmd = "/opt/Android/init-files.sh";
    exec(cmd, function(error, stdout, stderr) {
        if (error) {
            logger.error("cmd: " + cmd);
            logger.error("error: " + JSON.stringify(error, null, 2));
            logger.error("stdout: " + stdout);
            logger.error("stderr: " + stderr);
        }
        callback(error);
    });
};

var afterInitAndroid = function(reqestObj, logger, callback) {
    var platform = new Platform(logger);
    async.series(
        [
            function(callback) {
                var nfsoptions = "nolock,hard,intr,vers=3,nosharecache,noatime,async"; //user 0
                var src = [
                    reqestObj.nfs.nfs_ip + ":" + reqestObj.nfs.nfs_path +"/apks"
                ];
                var dst = [
                    "/Android/data/tmp"
                ];
                require('./mount.js').mountHostNfs(src, dst, nfsoptions, function(err) {
                    if (err) {
                        logger.info(err);
                    }
                    callback(err);
                });
            },
            function(callback) {
                var timeoutSec = 300;
                logger.info("Waiting upto " + timeoutSec + " seconds for 1st boot of android...");
                waitwaitForBootWithTimeout(platform, timeoutSec, callback);
            },
            function(callback) {
                setTimeout(function() {callback(null);}, 30*1000);
            },
            function(callback) {
                var cmd = "enable_houdini;pm refresh 0";
                logger.info("cmd: " + cmd);
                platform.exec(cmd, function(err, code, signal, sshout) {
                    callback(null);
                });
            },
            function(callback) {
                var timeoutSec = 300;
                logger.info("Waiting upto " + timeoutSec + " seconds for restart of android...");
                waitwaitForBootWithTimeout(platform, timeoutSec, callback);
            },
            function(callback) {
                if(reqestObj.settings.withService){
                    var cmd = "setprop ro.kernel.withService withService";
                    logger.info("cmd: " + cmd);
                    platform.exec(cmd, function(err, code, signal, sshout) {
                        callback(null);
                    });
                }
                else
                    callback(null);
            },
            function(callback) {
                if(reqestObj.settings.showOnlyControlPanel){
                    var cmd = "setprop ro.kernel.showOnlyControlPanel showOnlyControlPanel";
                    logger.info("cmd: " + cmd);
                    platform.exec(cmd, function(err, code, signal, sshout) {
                        callback(null);
                    });
                }
                else
                    callback(null);
            },
            function(callback) {
                setTimeout(function() {callback(null);}, 10*1000);
            }
        ], function(err) {
       callback(err);
        }
    );
};

var waitwaitForBootWithTimeout = function(platform, timeoutSec, callback) {
    var timeoutFlag = false;
    var timeoutObj = setTimeout(function() {
        timeoutFlag = true;
    }, timeoutSec * 1000); // setTimeout
    var waitForBoot = function(callback) {
        if (timeoutFlag) callback("timeout");
        else {
            setTimeout(function() {
                platform.exec("ps", function(err, code, signal, sshout) {
                    if (err) {
                        waitForBoot(callback);
                    } else {
                        if(sshout.indexOf("android.process.acore") === -1) {
                            waitForBoot(callback);
                        } else {
                            callback(null);
                        }
                    }
                });
            }, 4 * 1000);
        }
    };
    waitForBoot(callback);
};

function checkPlatformStatus(req, res) {

    var logger = new ThreadedLogger();
    var platform = new Platform(logger);
    var userName = req.params.username ? req.params.username : null;
    var deviceID = req.params.deviceid ? req.params.deviceid : null;;
    var platformIP = req.params.platformip ? req.params.platformip : null;;
    var resobj = {
        status: 0,
        error: 'no error'
    };


    async.series([
        function(callback) {
            if(!userName || !deviceID || !platformIP)
                callback("missing parameters");
            else
                callback(null);
        },
        //check platform responsiveness
        function(callback) {
            var cmd = "pm list users";
            platform.exec(cmd, function(err, code, signal, sshout) {
                if (err) {
                    callback(err);
                    return;
                }
                callback(null);
            });
        },
        //Check userlist.xml file exists
        function(callback) {
            var cmd = "netcfg";
            platform.exec(cmd, function(err, code, signal, sshout) {
                if (err) {
                    callback(err);
                    return;
                }
                var n = sshout.search("eth0[\t ]*UP[\t ]*" + platformIP + "/");
                if (n >= 0) {
                    callback(null);
                } else {
                    callback("dead platform");
                }
            });
        },
        //Check if such user already exist and !!!do nothing!!!
        function(callback) {
            // skip this check
            callback(null);
            return;

            var cmd = 'grep "<name>' + userName + deviceID + '</name>" /data/system/users/[0-9]*.xml';
            platform.exec(cmd, function(err, code, signal, sshout) {
                if (err) {
                    callback(err);
                    return;
                }
                var n = sshout.indexOf(UserName);
                if (n >= 0) {
                    var msg = "duplicate user id";
                    callback(msg);
                    return;
                }
                callback(null);
            }); // ssh.exec
        }
    ], function(err) {
        if (err) {
            logger.error("checkStatus: " + err);
            resobj.status = 0;
            resobj.error = err;
            res.end(JSON.stringify(resobj, null, 2));
            return;
        }

        resobj.status = 1;
        res.end(JSON.stringify(resobj, null, 2));
    });
}
