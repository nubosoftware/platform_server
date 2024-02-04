"use strict";

const Common = require('./common.js');
var logger = Common.getLogger(__filename);
const path = require('path');
const spawn = require('child_process').spawn;
const dgram = require('node:dgram');
const { add } = require('winston');
const fs = require('fs');


class NuboGLLocal {

    session;
    child;
    gwRTPSSRC;
    tag;

    static sessions = {};

    constructor(session) {
        this.session = session;
        NuboGLLocal.sessions[session.params.localid] = this;
        this.tag = `NuboGLLocal[${session.params.localid}]`;
    }

    static getSession(localid) {
        return NuboGLLocal.sessions[localid];
    }

    udpSend(buf,host,port) {
        return new Promise((resolve, reject) => {
            const client = dgram.createSocket('udp4');
            client.connect(port, host, (err) => {
                if (err) {
                    logger.error("Error in udpSend: " + err);
                    reject(err);
                    return;
                }
                client.send(buf, (err) => {
                    if (err) {
                        logger.error("Error in sendUDP: " + err);
                        reject(err);
                        return;
                    }
                    console.log("Buffer been send " + buf.toString('hex'));
                    client.close();
                    resolve();
                });
            });
        });
    }

    async sendUDPSignal(signal) {
        try {
            const listenPort = this.session.params.nuboglListenPort;
            const listenHost = "127.0.0.1";//this.session.params.nuboglListenHost;
            const buf = Buffer.allocUnsafe(1);
            buf.writeInt8(signal);
            await this.udpSend(buf, listenHost, listenPort);
        } catch (err) {
            logger.error(`${this.tag} Error in sendUDPSignal: ${err}`);
        }
    }

    async init() {
        try {
            const platid = this.session.params.platid;
            const localid = this.session.params.localid;
            this.gwRTPSSRC = ((platid & 0xFFFF) << 16 ) | (localid & 0xFFFF);
            logger.info(`${this.tag} Creating nubo gl local process. platid: ${platid}, localid: ${localid}, gwRTPSSRC: ${this.gwRTPSSRC}`);

            const gwRTPHost = "172.16.80.151";
            const gwRTPPort = 60005;
            const width = 602;
            const height = 1544;

            const encoder =  Common.nuboGL && Common.nuboGL.encoder ? Common.nuboGL.encoder :  "vaapih264enc";
            const listenPort = 22468 + Number(localid); // UDP port to listen for instructions from the gateway
            // 1 - play , 2 - pause
            var args = [
                gwRTPHost,
                gwRTPPort,
                this.gwRTPSSRC,
                width,
                height,
                encoder,
                listenPort,
            ];
            this.session.params.nuboglListenPort = listenPort;
            // this.session.params.nuboglListenHost
            const loggerName = `nubogl-${localid}`;
            const stdoutStream = fs.createWriteStream(`${Common.rootDir}/log/${loggerName}-out.log`);
            const stderrStream = fs.createWriteStream(`${Common.rootDir}/log/${loggerName}-err.log`);
            const nuboglPath = path.resolve(`./bin/nubogl`);
            var child = spawn('/usr/bin/stdbuf', ['-oL', '-eL', nuboglPath].concat(args), {
                cwd: this.session.params.externalSessPath,
                // uid : 1000,
                // gid : 1000,
                env: {
                    ...process.env,
                    //"DISPLAY": ":0",
                    //"XDG_RUNTIME_DIR": "/run/user/0",

                    // "XAUTHORITY": "/home/israel/.Xauthority",
                    //"XAUTHORITY": "/run/user/1002/.mutter-Xwaylandauth.0U6ZG2",
                    // "GST_VAAPI_ALL_DRIVERS": "1",
                    // "GST_DEBUG": "4",
                },
                stdio: ['inherit', 'pipe', 'pipe'], // Use 'pipe' for stdout and stderr
            });

            // Pipe child's stdout and stderr to file
            child.stdout.pipe(stdoutStream);
            child.stderr.pipe(stderrStream);

            // child.stdout.on('data', (data) => {
            //     logger.info(`${this.tag} stdout: ${data}`);
            // });

            // child.stderr.on('data', (data) => {
            //     logger.info(`${this.tag} stderr: ${data}`);
            // });

            child.on('close', (code) => {
                logger.info(`${this.tag} child process exited with code ${code}`);
                this.child = null;

            });
            this.child = child;
            logger.info(`${this.tag} Spawned child pid: ${child.pid}`);

        } catch (err) {
            logger.error(`${this.tag} Error in NuboGLLocal init: ${err}`);
        }
    }

    async afterAndroidStart() {
        try {
            logger.info(`${this.tag} afterAndroidStart`);
            await this.sendUDPSignal(1);
            // change resolution: 4 (byte) + width (int32) + height (int32)
        } catch (err) {
            logger.error(`${this.tag} Error in afterAndroidStart: ${err}`);
        }
    }

    async changeResolution(width, height) {
        try {
            logger.info(`${this.tag} changeResolution. width: ${width}, height: ${height}`);
            const buf = Buffer.allocUnsafe(9);
            buf.writeInt8(4);
            buf.writeInt32LE(width, 1);
            buf.writeInt32LE(height, 5);
            const listenPort = this.session.params.nuboglListenPort;
            const listenHost = "127.0.0.1";//this.session.params.nuboglListenHost;
            await this.udpSend(buf, listenHost, listenPort);
        } catch (err) {
            logger.error(`${this.tag} Error in changeResolution: ${err}`);
        }
    }

    async setNuboGLAddress(addr) {
        try {
            logger.info(`${this.tag} setNuboGLAddress. addr: ${addr}`);
            const buf = Buffer.allocUnsafe(2 + addr.length);
            buf.writeInt8(5);
            buf.writeInt8(addr.length,1);
            buf.write(addr, 2);
            const listenPort = this.session.params.nuboglListenPort;
            const listenHost = "127.0.0.1";
            await this.udpSend(buf, listenHost, listenPort);
        } catch (err) {
            logger.error(`${this.tag} Error in setNuboGLAddress: ${err}`);
        }
    }


    async killSession() {
        try {
            const child = this.child;
            if (child) {
                logger.info(`${this.tag} killing child pid: ${child.pid}`);
                child.kill();
            }
            delete NuboGLLocal.sessions[this.session.params.localid];
            logger.info(`${this.tag} Nubo gl deleted.`);

        } catch (err) {
            logger.error(`${this.tag} Error in killSession: ${err}`);
        }
    }
    static async killSession(localid) {
        try {
            const session = NuboGLLocal.getSession(localid);
            if (session) {
                await session.killSession();
            } else {
                logger.info(`NuboGLLocal. killSession. session not found. localid: ${localid}`);
            }
        } catch (err) {
            logger.error(`NuboGLLocal Error in killSession: ${err}`);
        }
    }
}


module.exports = NuboGLLocal;
