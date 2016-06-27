"use strict";

var async = require('async');
var util = require('util');
var underscore = require('underscore');
var exec = require('child_process').exec;
var Common = require('./common.js');
var logger = Common.logger;

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
            platform.exec("mount | cut -f 2 -d \" \"", function(err, code, signal, sshout) {
                var mounts = sshout.split(/[\r\n]+/);
                if (err || (code !== 0) || (mounts.indexOf("/")<0)) {
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
            var cmd = "";
            for (var i=0; i<dirs.length; i++) {
                cmd = cmd + "busybox umount -l " + dirs[i] + " ;\\\n";
            }
            logger.info("cmd:\n" + cmd);
            platform.exec(cmd, function(err, code, signal, sshout) {
                platform.exec("mount | cut -f 2 -d \" \"", function(err, code, signal, sshout) {
                    var mounts = sshout ? (sshout.split(/[\r\n]+/)) : [];
                    if(err || (code !== 0) || (mounts.indexOf("/")<0)) {
                        setTimeout(function() {
                            try_unmount(dirs, tries-1, callback);
                        }, 100);
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
            });
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

/*
 * Mount nfs directories
 * scr - array of strings, nfs-server directories
 * dst - array of strings, local directiories
 * mask - array of boolean, is directory mounted, to know which directories already mounted on previous tries, start value: all false
 * options - -o flag of mount command
 * callback(err, mask)
 *  err - null on success, otherwise string
 *  mask - result, on success should been all true
 */
function mountnfs(src, dst, mask, login, localid, platform, options, callback) {
    function do_mountnfs(retries, src, dst, mask, options, callback) {
        var cmd = "";
        for (var i=0; i<src.length; i++) {
            if(!mask[i]) {
                cmd = cmd + "mkdir -p " + dst[i] + " ; busybox mount -t nfs -o " + options + " " + src[i] + " " + dst[i] + " && \\\n";
            }

        }
        cmd += "true";
        logger.info("cmd:\n" + cmd);
        platform.exec(cmd, function(err, code, signal, sshout) {
            if (err) {
                var msg = "Error in adb shell: " + err;
                callback(msg, mask);
                return;
            }
            isMounted(dst, platform, function(err, res) {
                if (err || (res.indexOf(false) !== -1)) {
                    if (retries <= 1) {
                        var msg = "Error: cannot mount all nfs folders, err: " + err;
                        callback(msg, res);
                    } else {
                        setTimeout(function() {
                            do_mountnfs(retries-1, src, dst, res, options, callback);
                        }, 100);
                    }
                } else {
                    callback(null,res);
                }
            });
        });
    }

    do_mountnfs(4, src, dst, mask, options, callback);
}

function mountEcryptfs(src, dst, mask, login, localid, platform, options, password, key, callback) {
    if (src.length !== dst.length) {
        var msg = "ecryptfs Error: source and destination have different size";
        logger.info(msg);
        callback(msg);
        return;
    }
    var ecryptfs_sig = "beefbeefbeefbeef";
    var cmd = "";
    // create new session for storage of keys
    cmd = "keyctl new_session \\\n";
    // load password
    cmd = cmd + " && keyctl add user mykey " + password + " @s \\\n";
    // load key
    cmd = cmd + " && keyctl add encrypted " + ecryptfs_sig + " \"load " + key + "\" @s \\\n";
    for (var i=0; i<src.length; i++) {
        if(!mask[i]) {
            cmd = cmd + " && mkdir -p " + dst[i] + " \\\n" +
                " && busybox mount -i -t ecryptfs -o ecryptfs_sig=beefbeefbeefbeef" + "," + options + " " + src[i] + " " + dst[i] + " \\\n";
        }
    }
    // clean session, remove all loaded keys of session
    cmd = cmd + " && keyctl clear @s";
    cmd = cmd + " || (keyctl clear @s ; false)";
//    logger.info("cmd:\n" + cmd); //!!! Don't uncomment it, show password and key in log
    platform.exec(cmd, function(err, code, signal, sshout) {
        if(code !== 0) {
            var msg = "Cannot mount ecryptfs, errno=" + code + " err:" + err;
            logger.info(msg);
            callback(msg);
        } else {
            callback(null);
        }
    });
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

    var src = [
        nfsprefix + userDeviceDataFolder,
        nfsprefix + userDeviceDataFolder + 'system',
        nfsprefix_sd + userStorageFolder + 'media'
    ];
    var ecryptsrc = [
        '/data/mnt/ecrypt/' + localid + '/data',
        '/data/mnt/ecrypt/' + localid + '/system/users',
        '/data/mnt/ecrypt/' + localid + '/media'
    ];
    var dst = [
        '/data/user/' + localid,
        '/data/system/users/' + localid,
        '/data/media/' + localid
    ];
    var mask = [false, false, false];


    async.series([
        function(callback) {
            var nfsdst;
            if (keys)
                nfsdst = ecryptsrc;
            else
                nfsdst = dst;
            var nfsoptions = "nolock,hard,intr,vers=3,nosharecache,noatime,async,unum=" + localid;
            mountnfs(src, nfsdst, mask, login, localid, platform, nfsoptions, callback);
        },
        function(callback) {
            if (!keys) {
                callback(null);
                return;
            }
            mask = [false, false, false];
            var hardcoded_key = keys.ecryptfs_key;
            var hardcoded_password = keys.ecryptfs_password;
            var encryptoptions = "ecryptfs_cipher=aes,ecryptfs_key_bytes=32,ecryptfs_passthrough";
            mountEcryptfs(ecryptsrc, dst, mask, login, localid, platform, encryptoptions, hardcoded_password, hardcoded_key, callback);
        },
        function (callback) {
            externalMounts(login, session, callback);
        }
    ], function(err) {
        callback(err);
    });
}

function fullUmount(session, user, callback) {
    var UNum = session.params.localid;
    var platform = session.platform;
    var dirs = [
        "/data/user/" + UNum,
        "/data/system/users/" + UNum,
        "/data/media/" + UNum,
        "/data/mnt/ecrypt/" + UNum + "/data",
        "/data/mnt/ecrypt/" + UNum + "/system/users",
        "/data/mnt/ecrypt/" + UNum + "/media"
    ];
    umount(dirs, platform, callback);
}

function getUserHomeFolder(email) {
    var re = new RegExp('(.*)@(.*)');
    var m = re.exec(email);
    var domain = "none";
    if (m !== null && m.length >= 3) {
        domain = m[2];
    }
    var folder = domain + '/' + email + '/';
    return folder;
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
        var cmd = "";
        var msg;
        for (var i=0; i<src.length; i++) {
            if(!mask[i]) {
                cmd = cmd + "mkdir -p " + dst[i] + " ; timeout 10 mount -t nfs -o " + options + " " + src[i] + " " + dst[i] + " && \\\n";
            }
        }
        cmd += "cat /proc/mounts | cut -f 2 -d \" \"";
        logger.info("cmd:\n" + cmd);
        exec(cmd, function(err, stdout, stderr) {
            if (err) {
                msg = "Error in shell: " + err;
                callback(msg, mask);
                return;
            } else {
                var mounts = stdout.split(/[\r\n]+/);
                var res = underscore.map(dst, function(dir){ return mounts.indexOf(dir) !== -1; });
                if ((mounts.indexOf("/") === -1) || (res.indexOf(false) !== -1)) {
                    if (retries <= 1) {
                        msg = "Error: cannot mount all nfs folders, err: " + err;
                        callback(msg, res);
                    } else {
                        setTimeout(function() {
                            do_mountnfs(retries-1, src, dst, res, options, callback);
                        }, 100);
                    }
                } else {
                    callback(null, res);
                }
            }
        });
    }

    var mask = underscore.map(src, function(dir){ return false; });
    do_mountnfs(4, src, dst, mask, options, callback);
}


module.exports = {
    isMounted : isMounted,
    fullMount : fullMount,
    mountnfs : mountnfs,
    umount   : umount,
    fullUmount : fullUmount,
    mountHostNfs: mountHostNfs
};
