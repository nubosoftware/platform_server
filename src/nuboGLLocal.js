"use strict";

const Common = require('./common.js');
var logger = Common.getLogger(__filename);
const path = require('path');
const spawn = require('child_process').spawn;
const dgram = require('node:dgram');


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
            //const encoder = "vaapih264enc";
            // listenPort = 22468; // UDP port to listen for instructions from the gateway
            // 1 - play , 2 - pause
            var args = [
                gwRTPHost,
                gwRTPPort,
                //listenPort,
                this.gwRTPSSRC,
                width,
                height,
                //encoder,
            ];
            this.session.params.nuboglListenPort = 22468; // temporary until we generate the port for each session
            // this.session.params.nuboglListenHost

            // WAYLAND_DISPLAY=wayland-0
            // XAUTHORITY=/run/user/1002/.mutter-Xwaylandauth.KNGNG2
            // XDG_CONFIG_DIRS=/etc/xdg/xdg-ubuntu:/etc/xdg
            // XDG_CURRENT_DESKTOP=ubuntu:GNOME
            // XDG_DATA_DIRS=/usr/share/ubuntu:/home/israel/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop
            // XDG_MENU_PREFIX=gnome-
            // XDG_RUNTIME_DIR=/run/user/1002
            // XDG_SESSION_CLASS=user
            // XDG_SESSION_DESKTOP=ubuntu
            // XDG_SESSION_TYPE=wayland

            const nuboglPath = path.resolve(`./bin/nubogl`);
            var child = spawn('stdbuf', ['-oL', '-eL', nuboglPath].concat(args), {
                cwd: this.session.params.externalSessPath,
                // uid : 1000,
                // gid : 1000,
                env: {
                    "DISPLAY": ":0",
                    "XDG_RUNTIME_DIR": "/run/user/0",
                    // "XAUTHORITY": "/run/user/1002/gdm/Xauthority",
                    "XAUTHORITY": "/run/user/1002/.mutter-Xwaylandauth.KNGNG2",
                    // "GST_VAAPI_ALL_DRIVERS": "1",
                    // "GST_DEBUG": "4",
                }
            });
            child.stdout.on('data', (data) => {
                logger.info(`${this.tag} stdout: ${data}`);
            });

            child.stderr.on('data', (data) => {
                logger.info(`${this.tag} stderr: ${data}`);
            });

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
        } catch (err) {
            logger.error(`${this.tag} Error in afterAndroidStart: ${err}`);
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