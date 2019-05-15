"use strict";

var async = require('async');
var util = require('util');
var underscore = require('underscore');
var execFile = require('child_process').execFile;
var exec = require('child_process').exec;
var Common = require('./common.js');
var logger = Common.logger;
var fs = require('fs');
var validate = require("validate.js");
var constraints = require("nubo-validateConstraints")(true);
const path = require('path');


/*
 * Check is directories in mount points
 * on fail try check it again 5 times with intervals of 100ms
 * dirs - string or array of strings
 * platform - object from platform.js
 * callback(err, res)
 *  err - null on success, otherwise string
 *  res - boolean/array of booleans like dirs (true if directory mounted)
 */
function isMounted(dir, platform, callback) {
    function tryAgain(tries, dirs, callback) {
        if (tries<=0) {
            var msg = "Error: cannot check is directories mounted";
            callback(msg);
        } else {
            fs.readFile("/proc/mounts", 'utf8', function(err, data) {
                var mountLines = data.split(/[\r\n]+/);
                var mounts = underscore.map(mountLines, function(line) { return line.split(" ")[1]; });
                if(!mounts || (mounts.indexOf("/") === -1)) {
                    if (tries<=1) {
                        var msg = "Error: cannot check is directories mounted";
                        callback(msg);
                    }
                    setTimeout(function() {
                        tryAgain(tries-1, dirs, callback);
                    }, 100);
                } else {
                    var res = underscore.map(dirs, function(dir){ return mounts.indexOf(dir)>=0; });
                    callback(null, res);
                }
            });
        }
    }

    var dir_arr;
    if (util.isArray(dir)) {
        dir_arr = dir;
    } else {
        dir_arr = [dir];
    }
    tryAgain(5, dir_arr, function(err, res) {
        if (err) {
            callback(err, null);
        } else {
            if (util.isArray(dir)) {
                callback(null, res);
            } else {
                callback(null, res[0]);
            }
        }
    });
}

function umount(dir, platform, callback) {
    function try_unmount(dirs, tries, callback) {
        if (tries <= 0) {
            var msg = "Cannot umount directories " + dirs;
            callback(msg);
            return;
        } else {
            async.eachSeries(
                dirs,
                function(dir, callback) {
                    execFile("umount", ["-l", dir], function(err, stdout, stderr) {
                        callback(null);
                    });
                },
                function(err) {
                    fs.readFile("/proc/mounts", 'utf8', function(err, data) {
                        if(err) data = "";
                        var mountLines = data.toString().split(/[\r\n]+/);
                        var mounts = underscore.map(mountLines, function(line) { return line.split(" ")[1]; });
                        if (!mounts || (mounts.indexOf("/") === -1)) {
                            if (tries<=1) {
                                var msg = "Error: cannot check is directories mounted";
                                callback(msg);
                            } else {
                                logger.warn("Cannot get valid mount points");
                                setTimeout(function() {
                                    try_unmount(dirs, tries-1, callback);
                                }, 100);
                            }
                        } else {
                            var new_dirs = underscore.filter(dirs, function(dir){ return mounts.indexOf(dir)>=0; });
                            if (new_dirs.length > 0) {
                                setTimeout(function() {
                                    logger.info("new_dirs: " + new_dirs);
                                    try_unmount(new_dirs, tries-1, callback);
                                }, 100);
                            } else {
                                callback(null);
                            }
                        }
                    });
                }
            );
        }
    }
    if(platform === null) {
        var msg = "umount: platform is not defined";
        callback(msg);
        return;
    }
    var dir_arr;
    if (util.isArray(dir)) {
        dir_arr = dir;
    } else {
        dir_arr = [dir];
    }
    try_unmount(dir_arr, 4, callback);
}

//function mountEcryptfs(src, dst, mask, login, localid, platform, options, password, key, callback) {
//    if (src.length !== dst.length) {
//        var msg = "ecryptfs Error: source and destination have different size";
//        logger.info(msg);
//        callback(msg);
//        return;
//    }
//    var ecryptfs_sig = "beefbeefbeefbeef";
//    var cmd = "";
//    // create new session for storage of keys
//    cmd = "keyctl new_session \\\n";
//    // load password
//    cmd = cmd + " && keyctl add user mykey " + password + " @s \\\n";
//    // load key
//    cmd = cmd + " && keyctl add encrypted " + ecryptfs_sig + " \"load " + key + "\" @s \\\n";
//    for (var i=0; i<src.length; i++) {
//        if(!mask[i]) {
//            cmd = cmd + " && mkdir -p " + dst[i] + " \\\n" +
//                " && busybox mount -i -t ecryptfs -o ecryptfs_sig=beefbeefbeefbeef" + "," + options + " " + src[i] + " " + dst[i] + " \\\n";
//        }
//    }
//    // clean session, remove all loaded keys of session
//    cmd = cmd + " && keyctl clear @s";
//    cmd = cmd + " || (keyctl clear @s ; false)";
////    logger.info("cmd:\n" + cmd); //!!! Don't uncomment it, show password and key in log
//    platform.exec(cmd, function(err, code, signal, sshout) {
//        if(code !== 0) {
//            var msg = "Cannot mount ecryptfs, errno=" + code + " err:" + err;
//            logger.info(msg);
//            callback(msg);
//        } else {
//            callback(null);
//        }
//    });
//}

function mountNubouserfs(src, dst, options, callback) {
    var try_mount = function(args, callback) {
        execFile("mount", args, function(err, stdout, stderr) {
            if (err) {
                logger.error("mountNubouserfs: mkdir: " + err);
                logger.error("mountNubouserfs: mkdir: " + stderr);
            }
            callback(err);
        })
    };
    var mountArgs = underscore.map(src, function(item, index) {
        var args = ["-t", "nubouserfs", "-o", options, item, dst[index]];
        return args;
    });

    async.eachSeries(
        mountArgs,
        function(item, callback) {
            try_mount(item, callback);
        },
        function(err) {
            callback(err);
        }
    );
}

function bindDirs(src, dst, callback) {
    var try_mount = function(args, callback) {
        execFile("mount", args, function(err, stdout, stderr) {
            if (err) {
                logger.error("bindDirs: mount err: " + err);
                logger.error("bindDirs: mount stderr: " + stderr);
            }
            callback(err);
        })
    };
    var mountArgs = underscore.map(src, function(item, index) {
        var args = ["--bind", item, dst[index]];
        return args;
    });

    async.eachSeries(
        mountArgs,
        function(item, callback) {
            try_mount(item, callback);
        },
        function(err) {
            callback(err);
        }
    );
}

function externalMounts(login, session, callback) {
    var UserName = login.userName;
    var localid = session.params.localid;
    var platform = session.platform;

    if (Common.externalMountsSrc && Common.externalMountsSrc!=='') {
        try {
            var externalMountsModule = require(Common.externalMountsSrc);
            externalMountsModule.mount(login, session, function(err) {
                if(err) logger.error("Cannot mount external mounts err:" + err);
                callback(err);
            });
        } catch (e) {
            session.logger.error("Exception in "+Common.externalMountsSrc+" : "+e);
            callback(null);
        }
    } else { // if
        callback(null);
    }
}

function fullMount(session, keys, callback) {
    var login = session.login;
    var localid = session.params.localid;
    var platform = session.platform;
    var UserName = login.email;
    var deviceID = session.params.deviceid;
    var re = new RegExp('(.*)@(.*)');
    var nfs, nfs_slow;
    var nfshomefolder, nfshomefolder_slow;
    logger.info("mount.js - fullMount");
    logger.info("createUser obj:", JSON.stringify(session, null, 2));
    if (session.nfs) {
        nfs = session.nfs.nfs_ip;
        nfshomefolder = session.nfs.nfs_path;
    } else {
        logger.error("Missed nfs");
        callback("Missed nfs");
        return;
    }

    if (session.nfs_slow) {
        nfs_slow = session.nfs_slow.nfs_ip;
        nfshomefolder_slow = session.nfs_slow.nfs_path_slow || session.nfs_slow.nfs_path;
    } else {
        nfs_slow = nfs;
        nfshomefolder_slow = session.nfs.nfs_path_slow || nfshomefolder;
    }

    var nfsprefix = nfs + ":" + nfshomefolder + "/";
    var nfsprefix_sd = nfs_slow + ":" + nfshomefolder_slow + "/";
    var userDeviceDataFolder = getUserHomeFolder(UserName) + deviceID + "/";
    var userStorageFolder = getUserHomeFolder(UserName) + "storage/";

    var nfsSrc = [
        nfsprefix + userDeviceDataFolder,
        nfsprefix_sd + userStorageFolder + "media"
    ];
    var nfsDst = [
        "/Android/data/mnt/nfs/" + localid,
        "/Android/data/media/" + localid
    ];

    var mkdirs = [
        /*"/Android/data/mnt/nubouserfs/" + localid + "/misc/profiles/cur",
        "/Android/data/misc_ce/" + localid,
        "/Android/data/misc_de/" + localid,
        "/Android/data/system/users/" + localid,
        "/Android/data/system_ce/" + localid,
        "/Android/data/system_de/" + localid,
        "/Android/data/mnt/nubouserfs/" + localid + "/user",
        "/Android/data/mnt/nubouserfs/" + localid + "/user_de"*/
    ];

    var nubouserfsSrc = [
        "/Android/data/mnt/nfs/" + localid + "/misc/profiles/cur",
        "/Android/data/mnt/nfs/" + localid + "/user",
        "/Android/data/mnt/nfs/" + localid + "/user_de"
    ];
    var nubouserfsDst = [
        "/Android/data/misc/profiles/cur/" + localid,
        "/Android/data/user/" + localid,
        "/Android/data/user_de/" + localid
    ];

    var bindSrc = [
        "/Android/data/mnt/nfs/" + localid + "/misc_ce",
        "/Android/data/mnt/nfs/" + localid + "/misc_de",
        "/Android/data/mnt/nfs/" + localid + "/system/users",
        "/Android/data/mnt/nfs/" + localid + "/system_ce",
        "/Android/data/mnt/nfs/" + localid + "/system_de"
    ];
    var bindDst = [
        "/Android/data/misc_ce/" + localid,
        "/Android/data/misc_de/" + localid,
        "/Android/data/system/users/" + localid,
        "/Android/data/system_ce/" + localid,
        "/Android/data/system_de/" + localid
    ];

    async.series([
        /*function(callback) {
            mkDirs(mkdirs, callback);
        },*/
        function(callback) {
            var nfsoptions = "nolock,hard,intr,vers=4,noatime,async,fsc";
            mountHostNfs(nfsSrc, nfsDst, nfsoptions, callback);
        },
        function(callback) {
            fs.chmod("/Android/data/mnt/nfs/" + localid, '777', callback);
        },
        function(callback) {
            var options = "unum=" + localid;
            mountNubouserfs(nubouserfsSrc, nubouserfsDst, options, callback);
        },
        function(callback) {
            bindDirs(bindSrc, bindDst, callback);
        },
        function(callback) {
            if (session.mounts) {
                mountAdditionalFolders(session.mounts,"/Android/data/media/" + localid,function(err) {
                    callback(null);
                });
            } else {
                callback(null);
            }
        },
        //function(callback) {
        //    if (!keys) {
        //        callback(null);
        //        return;
        //    }
        //    mask = [false, false, false];
        //    var hardcoded_key = keys.ecryptfs_key;
        //    var hardcoded_password = keys.ecryptfs_password;
        //    var encryptoptions = "ecryptfs_cipher=aes,ecryptfs_key_bytes=32,ecryptfs_passthrough";
        //    mountEcryptfs(ecryptsrc, dst, mask, login, localid, platform, encryptoptions, hardcoded_password, hardcoded_key, callback);
        //},
        //function (callback) {
        //    externalMounts(login, session, callback);
        //}
    ], function(err) {
        callback(err);
    });
}

function fullUmount(session, user, callback) {
    var UNum = session.params.localid;
    var platform = session.platform;
    var dirs = [
        "/Android/data/misc/profiles/cur/" + UNum,
        "/Android/data/misc_ce/" + UNum,
        "/Android/data/misc_de/" + UNum,
        "/Android/data/system/users/" + UNum,
        "/Android/data/system_ce/" + UNum,
        "/Android/data/system_de/" + UNum,
        "/Android/data/user/" + UNum,
        "/Android/data/user_de/" + UNum,
        "/Android/data/media/" + UNum,
        "/Android/data/mnt/nfs/" + UNum
    ];
    umount(dirs, platform, callback);
}

function getUserHomeFolder(email) {
    var res = validate.single(email, constraints.pathConstrRequested);
    if (res) {
        return null;
    }
    var re = new RegExp('(.*)@(.*)');
    var m = re.exec(email);
    var domain = "none";
    if (m !== null && m.length >= 3) {
        domain = m[2];
    }
    var folder = domain + '/' + email + '/';
    return folder;
}

function mkDirs(dst, callback) {

    console.log("mkDirs");

    async.eachSeries(dst,
        function (dest, callback) {
            var mkdirParams = ['-p', dest];
            execFile('mkdir', mkdirParams, function (err, stdout, stderr) {
                if (err) {
                    logger.error("mkDirs: mkdir: " + err);
                    logger.error("mkDirs: mkdir: " + stderr);
                    callback(err);
                    return;
                }
                logger.info("mkDirs: mkdir: " + mkdirParams);
                callback(null);
            });
        }, function(err) {
            callback(err);
        }
    );

}

/*
 * Mount nfs directories
 * scr - array of strings, nfs-server directories
 * dst - array of strings, local directiories
 * options - -o flag of mount command
 * callback(err, mask)
 *  err - null on success, otherwise string
 *  mask - result, on success should been all true
 */
function mountHostNfs(src, dst, options, callback) {
    function do_mountnfs(retries, src, dst, mask, options, callback) {
        console.log("mountHostNfs do_mountnfs retries=" + retries);
        var i = 0;

        async.eachSeries(src,
            function(source, callback) {

                if (mask[i]) {
                    callback(null);
                    return;
                }

                async.series([
                    function(callback) {
                        var mkdirParams = ['-p', dst[i]];
                        execFile('mkdir', mkdirParams, function(err, stdout, stderr) {
                            if (err) {
                                logger.error("do_mountnfs: mkdir: " + err);
                                logger.error("do_mountnfs: mkdir: " + stderr);
                                callback(err);
                                return;
                            }

                            callback(null);
                        });
                    },
                    function(callback) {

                        var mountParams = ['-t', 'nfs4', '-o', options, src[i], dst[i]];
                        var mountOpts = {
                            timeout: 10000
                        };
                        execFile('mount', mountParams, mountOpts, function(err, stdout, stderr) {
                            if (err) {
                                logger.error("do_mountnfs: mount: " + err);
                                logger.error("do_mountnfs: mount: " + stderr);
                                callback(err);
                                return;
                            }

                            i++;
                            callback(null);
                        });
                    }
                ], callback);
            },
            function(err) {
                if (err) {
                    callback(err);
                    return;
                }

                fs.readFile('/proc/mounts', 'utf8', function(err, data) {
                    if (err) {
                        logger.error("do_mountnfs: mounts: " + err);
                        callback("couldn't open mounts file");
                        return;
                    }

                    var dataArray = data.split(/[\r\n]+/);
                    var mounts = underscore.map(dataArray, function(mnt) {
                        return mnt.split(" ")[1];
                    });

                    var res = underscore.map(dst, function(dir) {
                        return mounts.indexOf(dir) !== -1;
                    });


                    if ((mounts.indexOf("/") === -1) || (res.indexOf(false) !== -1)) {
                        if (retries <= 1) {
                            var errMsg = "cannot mount all nfs folders";
                            logger.error("do_mountnfs: " + errMsg);
                            callback(errMsg, res);
                            return;
                        }

                        setTimeout(function() {
                            do_mountnfs(retries - 1, src, dst, res, options, callback);
                        }, 100);
                    } else {
                        callback(null, res);
                    }
                });
            }
        );
    }

    var mask = underscore.map(src, function(dir) {
        return false;
    });
    do_mountnfs(4, src, dst, mask, options, callback);
}


function escapeMountParam(src) {
    return src.replace(/([!@#$%^&\*`\\])/g,"\\$1");
}

function buildPath() {

    var illegalPath = 'ILLEGAL_PATH';
    var newPath = [];
    var size = arguments.length;
    for (var arg of arguments) {

        try {
            var res = validate.single(arg, constraints.pathConstrRequested);
            if (res) {
                logger.error("buildPath: " + res + ", path \'" + arg + "\'");
                return illegalPath;
            }
        } catch (error) {
            logger.error("buildPath: " + error.toString() + ", path \'" + arg + "\'");
            return illegalPath;
        }

        newPath.push(path.resolve("/" + arg));
    }

    var ret = path.join.apply(null, newPath);
    if (arguments[size-1].slice(-1) === "/" && arguments[size-1] !== "/") {
        ret += "/";
    }
    return ret;
}

/*
 * Mount additional folders (currently support cifs only)
 * mounts - array of object in the format of:
 * {
                folder: "android_folder_name",
                type: "cifs",
                orgUser: "user_name",
                orgPassword: "password",
                domain: "domain.com",
                serverIP: "ip_address",
                shareName: "//host/share_name"
    }
 * mediaFolder - path of the user sdcard
 * callback(err, mask)
 *  err - null on success, otherwise string
 *  mask - result, on success should been all true
 */
function mountAdditionalFolders(mounts, mediaFolder, callback) {
    function do_mount_folders(retries, mounts, mask, callback) {
        console.log("mountAdditionalFolders do_mount_folders retries=" + retries);
        var i = 0;

        async.eachSeries(mounts,
            function(source, callback) {

                if (mask[i]) {
                    callback(null);
                    return;
                }

                if (source.type !== "cifs") {
                    callback("Invalid mount type: "+source.type);
                    return;
                }
                if (!source.folder || !source.orgUser || !source.orgPassword || !source.domain || !source.domain || !source.serverIP || !source.shareName) {
                    callback("Invalid cifs paramteres");
                    return;
                }

                var localFolder = buildPath(mediaFolder,source.folder);

                async.series([
                    function(callback) {
                        var mkdirParams = ['-p',  localFolder ];
                        execFile('mkdir', mkdirParams, function(err, stdout, stderr) {
                            if (err) {
                                logger.error("do_mount_folders: mkdir: " + err);
                                logger.error("do_mount_folders: mkdir: " + stderr);
                                callback(err);
                                return;
                            }

                            callback(null);
                        });
                    },
                    function(callback) {
                        var options = "user="+escapeMountParam(source.orgUser)+",password="+escapeMountParam(source.orgPassword)+
                            ",domain="+escapeMountParam(source.domain)+",serverino,ip="+source.serverIP+",uid=1023,gid=1023,actimeo=1";
                        var mountParams = ['-t', 'cifs', '-o', options, source.shareName, localFolder];
                        var mountOpts = {
                            timeout: 10000
                        };

                        var cmd = "mount "+mountParams.join(" ");
                        // security - consider change to execFile
                        exec(cmd, mountOpts, function(err, stdout, stderr) {
                            if (err) {
                                logger.error("do_mount_folders: mount: " + err);
                                logger.error("do_mount_folders: mount: " + stderr);
                                callback(err);
                                return;
                            }

                            i++;
                            callback(null);
                        });
                    }
                ], callback);
            },
            function(err) {
                if (err) {
                    callback(err);
                    return;
                }

                fs.readFile('/proc/mounts', 'utf8', function(err, data) {
                    if (err) {
                        logger.error("do_mountnfs: mounts: " + err);
                        callback("couldn't open mounts file");
                        return;
                    }

                    var dataArray = data.split(/[\r\n]+/);
                    var dstmounts = underscore.map(dataArray, function(mnt) {
                        return mnt.split(" ")[1];
                    });

                    var srcmounts = underscore.map(mounts, function(source) {
                        return buildPath(mediaFolder,source.folder);
                    });


                    var res = underscore.map(srcmounts, function(dir) {
                        return dstmounts.indexOf(dir) !== -1;
                    });


                    if ((dstmounts.indexOf("/") === -1) || (res.indexOf(false) !== -1)) {
                        if (retries <= 1) {
                            var errMsg = "cannot mount all cifs folders";
                            logger.error("do_mount_folders: " + errMsg);
                            callback(errMsg, res);
                            return;
                        }

                        setTimeout(function() {
                            do_mount_folders(retries - 1, mounts, res,  callback);
                        }, 100);
                    } else {
                        callback(null, res);
                    }
                });
            }
        );
    }

    var mask = underscore.map(mounts, function(source) {
        return false;
    });
    do_mount_folders(4, mounts,  mask,  callback);
}

module.exports = {
    isMounted : isMounted,
    fullMount : fullMount,
    fullUmount : fullUmount,
    mountHostNfs: mountHostNfs
};
