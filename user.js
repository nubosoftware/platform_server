"use strict";

var fs = require('fs');
var async = require('async');
var validate = require("validate.js");
//var Common = require('./common.js');
//var logger = Common.logger;
var ThreadedLogger = require('./ThreadedLogger.js');
var exec = require('child_process').exec;
var mount = require('./mount.js');
var Platform = require('./platform.js');
var http = require('./http.js');

module.exports = {
    attachUser: attachUser,
    detachUser: detachUser,
    //for tests
    createUser: createUser,
    endSessionByUnum: endSessionByUnum
};

function attachUser(req, res) {
    var resDone = false;
    var logger = new ThreadedLogger();
    var unum = 0;
    logger.logTime("Start process request attachUser");

    async.waterfall(
        [
            //get data from post request
            function (callback) {
                http.getObjFromRequest(req, function(err, obj) {
                    callback(err, obj);
                });
            },
            function (reqestObj, callback) {
                validateAttachUserRequestObj(reqestObj, logger, callback);
            },
            //create workable android user
            function (reqestObj, callback) {
                console.log("reqestObj: ", reqestObj);
                createUser(reqestObj, logger, callback);
            },
            //response to request on success
            function (session, callback) {
                unum = session.params.localid;
                var resobj = {
                    status: 1,
                    localid: unum
                };
                resDone = true;
                res.end(JSON.stringify(resobj,null,2));
                callback(null, session);
            },
            //post create processes (attach applications, etc)
            function (session, callback) {
                callback(null);
            }
        ], function (err) {
            if(err) {
                if(!resDone) {
                    var resobj = {
                        status: 0,
                        error: err
                    };
                    res.end(JSON.stringify(resobj,null,2));
                }
                logger.error("request finished with error: " + err);
            }
            logger.logTime("Finish process request attachUser");
        }
    );
}

function detachUser(req, res) {
    var unum = req.params.unum;
    var logger = new ThreadedLogger();
    logger.logTime("Start process request detachUser");
    var platform = new Platform(logger);
    var resobj;
    if(isNaN(unum) || (unum <= 0)) {   // is unum does not greater that 0 mean check if unum is number too
        resobj = {status: 0, message: "invalid unum, unum is " + unum};
        res.end(JSON.stringify(resobj,null,2));
    } else {
        endSessionByUnum(unum, logger, function (err) {
            if(err) {
                resobj = {status: 0, error: err};
            } else {
                resobj = {status: 1, message: "User " + unum + " removed"};
            }
            res.end(JSON.stringify(resobj,null,2));
            logger.logTime("Finish process request detachUser");
        });
    }
}

function createUser(obj, logger, callback) {
    var timeZone = obj.timeZone;
    var localid = 0;
    var platform = new Platform(logger);
    var session = {
        login: obj.login,
        platform: platform,
        logger: logger,
        nfs: obj.nfs
    };
    var addToErrorsPlatforms = false;
    var platformErrorFlag = false;

    /*
     * Create startup.json, Session.xml, sessionid
     */
    //function createSessionFiles(session, callback) {
    //    var login = session.login;
    //    async.series([
    //            // Handle certificate if one exists
    //            function (callback) {
    //                var domain = login.mainDomain;
    //                var email = login.userName;
    //                User.handleCertificatesForUser(domain, email, deviceID, callback);
    //            },
    //            function (callback) {
    //                //create imServerParams file
    //                User.saveIMSettingsFile(session.email, login.imUserName, deviceID, localid, function (err) {
    //                    if(err) {
    //                        logger.error("Error saveIMSettingsFile : " + err);
    //                    }
    //                    callback(null);
    //                });
    //            },
    //            function (callback) {
    //                //create Session.xml
    //                var rootFolder = Common.nfshomefolder;
    //                var xml_file = rootFolder + User.getUserDeviceDataFolder(UserName, deviceID) + "Session.xml";
    //                logger.info("rootFolder: " + rootFolder + ", xml_file: " + xml_file);
    //                var xml_file_content = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\r\n" +
    //                    "<session>\r\n" +
    //                    "\t<gateway_url>" + session.params.gatewayInternal + "</gateway_url>\r\n" +
    //                    "\t<gateway_controller_port>" + session.params.gatewayControllerPort + "</gateway_controller_port>\r\n" +
    //                    "\t<gateway_apps_port>" + session.params.gatewayAppsPort + "</gateway_apps_port>\r\n" +
    //                    "\t<platformID>" + platform.params.platid + "</platformID>\r\n" +
    //                    "\t<management_url>" + Common.serverurl + "</management_url>\r\n" +
    //                    "\t<username>" + login.loginParams.userName + "</username>\r\n" +
    //                    "</session>\r\n";
    //                createFile(xml_file, xml_file_content, '600', 1000, 1000, function (err) {
    //                    callback(err);
    //                });
    //            },
    //            function (callback) {
    //                var rootFolder = Common.nfshomefolder;
    //                var sess_file = rootFolder + User.getUserDeviceDataFolder(UserName, deviceID) + "sessionid";
    //                //logger.info("rootFolder: "+rootFolder+", sess_file: "+sess_file);
    //                var sess_file_content = session.params.sessid;
    //                createFile(sess_file, sess_file_content, '644', 1000, 1000, function (err) {
    //                    callback(err);
    //                });
    //            }
    //        ], function (err) {
    //            //logger.info("Session.xml and sessionid created succesfully");
    //            if(err) {
    //                logger.info("Error: Cannot create session description files");
    //            }
    //            callback(err);
    //        }
    //    );
    //}

    /**
     * Run am create-user on the platform
     */

    function amCreateUser(platform, session, callback) {
        var cmd = 'am create-user ' + localid;
        platform.exec(cmd, function (err, code, signal, sshout) {
            if(err) {
                var msg = "Error in adb shell: " + err;
                platformErrorFlag = true;
                callback(msg);
                return;
            }
            callback(null);
        });
        // ssh.exec
    }

    /*
     * create android user, chech his number, empty directories
     * Arguments:
     *  callback(err, localid)
     *  err - error message, if exist
     *  localid - number of created user
     */
    function createUserAndroid(callback) {
        var localid;
        async.series([
                // create user
                function (callback) {
                    var cmd = 'pm create-user ' + session.params.email + session.params.deviceid;
                    console.log("cmd: " + cmd);
                    platform.exec(cmd, function (err, code, signal, sshout) {
                        if(err) {
                            addToErrorsPlatforms = true;
                            var msg = "Error in adb shell: " + err;
                            platformErrorFlag = true;
                            callback(msg);
                            return;
                        }
                        var re = new RegExp('Success: created user id ([0-9]+)');
                        var m = re.exec(sshout);
                        if(m) {
                            localid = m[1];
                            logger.logTime("pm create-user");
                            callback(null);
                        } else {
                            callback("Error with PM - cannot get localid");
                        }
                    }); // ssh.exec
                }, //function(callback)
                // Remove directory that was created by Android for new user and mount our directory instead
                function (callback) {
                    var cmd = 'rm -rf /data/user/' + localid +
                        ' ; sync' + ' ; mkdir /data/user/' + localid +
                        ' ; mkdir /data/system/users/' + localid +
                        ' ; sync' + ' ; chown system:system /data/user/' +
                        ' ; rm /data/misc/keystore/user_' + localid + '/*';
                    //console.log("cmd: "+cmd);
                    platform.exec(cmd, function (err, code, signal, sshout) {
                        if(err) {
                            var msg = "Error in adb shell: " + err;
                            callback(msg);
                            return;
                        }
                        logger.logTime("rm, mkdir etc..");
                        callback(null);
                    }); // ssh.exec
                }, //function(callback)
            ], function (err) {
                if(err) {
                    logger.info("Error: cannot initializate android user err:" + err);
                }
                callback(err, localid);
            }
        );
    }

// End of definitions

    /*
     * Start of code
     */
    async.series([
        function (callback) {
            session.params = {
                email: obj.session.email,
                deviceid: obj.session.deviceid
            };
            callback(null);
        },
        // create user
        function (callback) {
            createUserAndroid(function (err, res) {
                if(!err) localid = res;
                callback(err);
            });
        },
        // create session files
//            function(callback) {
//                createSessionFiles(platform, session, function(err) {
//                    logger.logTime("createSessionFiles");
//                    callback(err);
//                });
//            },
        // mount all nfs folders
        function (callback) {
            session.params.localid = localid;
            mount.fullMount(session, null, function (err) {
                if(err) logger.error("Cannot mount user's directories");
                logger.logTime("fullMount");
                callback(err);
            });
        },
        function (callback) {
            refreshPackages(session, function (err) {
                logger.logTime("refreshPackages");
                callback(err);
            });
        },
        function (callback) {
            setPerUserEnvironments(session, timeZone, callback);
        },
        function (callback) {
            amCreateUser(platform, session, function (err) {
                logger.logTime("amCreateUser");
                callback(err);
            });
        },
    ], function (err, results) {
        if(err) {
            logger.info("Error during session create: " + err);
            endSessionByUnum(localid, logger, function (error) {
                callback(err);
            });
        } else {
            logger.info("User attached successfully");
            callback(null, session);
        }
    });
    return;
}

function setPerUserEnvironments(session, timeZone, callback) {
    var login = session.login;
    var email = login.userName;
    var localid = session.params.localid;
    var errormsg = "";

    var lang = login.lang;
    var countrylang = login.countrylang;
    var localevar = login.localevar;

    var lineLanguage = 'setprop persist.sys.language.u' + localid + ' \"' + lang + '\"';
    var lineCountryLang = 'setprop persist.sys.country.u' + localid + ' \"' + countrylang + '\"';
    var lineLocalevar = 'setprop persist.sys.localevar.u' + localid + ' \"' + localevar + '\"';

    var cmd = lineLanguage + ';\\\n' + lineCountryLang + ';\\\n' + lineLocalevar + ';\\\n';
    if(timeZone !== null && timeZone !== "") {
        cmd = cmd + 'setprop persist.sys.timezone.u' + localid + ' \"' + timeZone + '\";\\\n';
    } else {
        session.logger.error("ERROR: missing timeZone param.");
    }
    session.logger.info("cmd:\n" + cmd);
        session.platform.exec(cmd, function (err, code, signal, sshout) {
        if(err) {
            var msg = "Error in adb shell: " + err;
            session.logger.info(msg);
        }
        callback(null);
    }); // ssh.exec
}

function refreshPackages(session, callback) {
    var localid = session.params.localid;
    var platform = session.platform;
    var deviceType = session.login.deviceType;
    var cmd = 'pm refresh ' + localid;
    if(deviceType === 'Web') {
        cmd = cmd + "; pm disable --user " + localid + " com.android.browser";
    }
    session.logger.info('cmd: ' + cmd);
    platform.exec(cmd, function (err, code, signal, sshout) {
        callback(err);
    }); // ssh.exec
}

// This function should been called after session and platform locked
// session can been null, platform can been null
function endSessionByUnum(unum, logger, callback) {
    var platform = new Platform(logger);
    var sessLogger = logger;
    async.series(
        [
            function (callback) {
                if(unum === 0) {
                    callback("no UNum");
                } else {
                    async.series(
                        [
                            // Logout. pm remove-user close all user's applications
                            function (callback) {
                                var cmd = 'pm remove-user ' + unum;
                                //console.log("cmd: " + cmd);
                                logger.info(cmd);
                                platform.exec(cmd, function (err, code, signal, sshout) {
                                    sessLogger.logTime("pm remove-user");
                                    callback(null);
                                    // Try to continue even if pm failed
                                });
                                // platform.exec
                            }, // function(callback)
                            // force close all user's applications if it still exist
                            function (callback) {
                                var cmd = "kill `ps | grep ^u" + unum + "_ | awk '{print $2}'`";
                                logger.info("cmd: " + cmd);
                                platform.exec(cmd, function (err, code, signal, sshout) {
                                    if(err) {
                                        var msg = "Error in adb shell: " + err;
                                        callback(msg);
                                        return;
                                    }
                                    logger.logTime("kill all processes, " + sshout);
                                    callback(null);
                                });
                                // platform.exec
                            }, // function(callback)
                            // unmount folders
                            function (callback) {
                                var session = {
                                    params: {
                                        localid: unum
                                    },
                                    platform: platform
                                };
                                mount.fullUmount(session, null, function (err) {
                                    if(err) {
                                        logger.info("ERROR: cannot umount user's directories, err:" + err);
                                        callback(err);
                                    } else {
                                        callback(null);
                                    }
                                });
                            }, // function(callback)
                            // rm files of logouted user (after umount of all user's data)
                            function (callback) {
                                var cmd = "rm -rf /data/system/users/" + unum +
                                    " ; rm /data/system/users/" + unum + ".xml" +
                                    " ; rm -rf /data/user/" + unum +
                                    " ; rm -rf /data/media/" + unum +
                                    " ; rm /data/misc/keystore/user_" + unum + "/*";
                                logger.info("cmd: " + cmd);
                                platform.exec(cmd, function (err, code, signal, sshout) {
                                    if(err) {
                                        var msg = "Error in adb shell: " + err;
                                        callback(msg);
                                        return;
                                    }
                                    logger.logTime("rm folder");
                                    callback(null);
                                });
                                // ssh.exec
                            }, // function(callback)
                        ], function (err, results) {
                            callback(err);
                        }
                    );
                }
            }
        ], function (err, results) {
            if(err) {
                logger.error("Error during user detach: " + err);
            }
            callback(err);
        }
    );
}

function createFile(file, data, permissions, uid, gid, callback) {
    async.series(
        [
            function (callback) {
                fs.writeFile(file, data, function (err) {
                    callback(err);
                });
            },
            function (callback) {
                fs.chmod(file, permissions, function (err) {
                    callback(err);
                });
            },
            function (callback) {
                fs.chown(file, uid, gid, function (err) {
                    callback(err);
                });
            }
        ], function (err) {
            callback(err);
        }
    );
}

var validateAttachUserRequestObj = function(requestObj, logger, callback) {
    var validate = require("validate.js");
    var constraints = require("nubo-validateConstraints");

    var constraint = {
        timeZone: {
            format: "[a-zA-Z0-9\\.\\_\\-\\/]+",
            length: {
                "minimum" : 1,
                "maximum" : 256
            }
        },
        login: {presence: true},
        "login.userName": constraints.requestedExcludeSpecialCharacters,
        "login.email": {presence: true, email: true},
        "login.lang": {
            format: "[a-zA-Z0-9\\.\\_\\-]+",
            length: {
                "minimum" : 1,
                "maximum" : 256
            }
        },
        "login.countrylang": {
            format: "[a-zA-Z0-9\\.\\_\\-]+",
            length: {
                "minimum" : 1,
                "maximum" : 256
            }
        },
        "login.localevar": {
            format: "[a-zA-Z0-9\\.\\_\\-]+",
            length: {
                "minimum" : 1,
                "maximum" : 256
            }
        },
        "login.deviceType": constraints.excludeSpecialCharacters,
        session: {presence: true},
        "session.email": {presence: true, email: true},
        "session.deviceid": constraints.requestedExcludeSpecialCharacters,
        nfs: {presence: true},
        "nfs.nfs_ip": constraints.ipConstr,
        "nfs.nfs_path": constraints.pathConstrRequested,
        "nfs.nfs_path_slow": constraints.pathConstrOptional,
        nfs_slow: {},
        "nfs_slow.nfs_ip": constraints.ipOptionalConstr,
        "nfs_slow.nfs_path": constraints.pathConstrOptional,
        "nfs_slow.nfs_path_slow": constraints.pathConstrOptional
    };
    var res = validate(requestObj, constraint);
    if(res) logger.error("input is not valid: " + JSON.stringify(res));
    callback(res, requestObj);
};

