#include <stdio.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <pulse/simple.h>
#include <pulse/error.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <arpa/inet.h>
#include <pthread.h>
#include <stdlib.h>
#include <sys/time.h>
#include <syslog.h>
#include <linux/tcp.h>
#include <sys/stat.h>

#define BUFSIZE 1024
#define OP_OUT_WRITE 1
#define OP_IN_READ 2
#define OP_OPEN_INPUT_STREAM 3
#define OP_PA_CREATE 100
#define SOCKETPREFIX "/Android/dev/socket/audio"

void *connection_handler(void *);
int unum;

struct thread_args {
    int sock_fd;
    int userId;
    pa_simple *s;
    thread_args(int fd): sock_fd(fd), s(NULL) {}
};

struct server_args {
    int sock_fd;
    int userId;
    char path[108];
    pa_simple *s;
    server_args(): sock_fd(0), s(NULL) {}
};

static struct server_args server_in_args, server_out_args;

void sig_handler(int signo)
{
    switch(signo) {
        case SIGINT:
        case SIGTERM:
            syslog(LOG_NOTICE, "signal %d has been received x\n", signo);
            syslog(LOG_INFO, "closing socket %d\n", server_out_args.sock_fd);
            close(server_out_args.sock_fd);
            server_out_args.sock_fd = 0;
            syslog(LOG_INFO, "closing socket %d\n",server_in_args.sock_fd);
            close(server_in_args.sock_fd);
            server_in_args.sock_fd = 0;
            break;
        default:
            syslog(LOG_WARNING, "unexpected signal %d has been received\n", signo);
    }
}

static int out_write(struct thread_args *ta, const void *buf, int size) {
    int res;
    int response = size;
    int error;
    struct timeval now;

    if(ta->s) {
        //gettimeofday(&now, NULL);
        //syslog(LOG_DEBUG, "time: %ld.%03d out_write1: size=%d, pa_simple_write  return %d\n", now.tv_sec, (int)now.tv_usec/1000, size, res);
        res = pa_simple_write(ta->s, buf, size, &error);
        //gettimeofday(&now, NULL);
        //syslog(LOG_DEBUG, "time: %ld.%03d out_write2: size=%d, pa_simple_write  return %d\n", now.tv_sec, (int)now.tv_usec/1000, size, res);
    } else {
        syslog(LOG_ERR, "out_write() called before pulseaudio initialization\n");
    }
    send(ta->sock_fd, &response, 4, 0);
    return res;
}

static int in_read(struct thread_args *ta, const void *buf, int size) {
    int res;
    int response = size;
    int error;
    int i;
    int rec_size = *(int *)buf;
    void *response_buf;
    struct timeval now;

    gettimeofday(&now, NULL);
    response_buf = malloc(rec_size + 4);
    if(response_buf == NULL) {
        syslog(LOG_ERR, "in_read() rec_buf allocation failed\n");
    }
    if(ta->s) {
        *(int *)response_buf = rec_size;
        res = pa_simple_read(ta->s, (char *)response_buf + 4, rec_size, &error);
        //syslog(LOG_DEBUG, "time: %ld.%03d in_read: size=%d, pa_simple_read  return %d\n", now.tv_sec, (int)now.tv_usec/1000, rec_size, res);
    } else {
        syslog(LOG_ERR, "out_write() called before pulseaudio initialization, socket %d\n", ta->sock_fd);
    }
    if(response_buf) {
        res = send(ta->sock_fd, response_buf, rec_size + 4, 0);
        free(response_buf);
        syslog(LOG_ERR, "in_read() send %d bytes\n", res);
    } else {
        error = 0;
        for(i = 0; i < size; i += 4) {
            send(ta->sock_fd, &error, 4, 0);
        }
        for(i = 0; i < size; i++) {
            send(ta->sock_fd, &error, 1, 0);
        }
    }
    return size;
}

static int open_input_stream(struct thread_args *ta, const void *buf, int size) {
    int res;
    int response = 0;
    int error;
    struct timeval now;

    gettimeofday(&now, NULL);
    if(ta->s) {
        res = pa_simple_flush(ta->s, &error);
        syslog(LOG_DEBUG, "time: %ld.%03d open_input_stream: pa_simple_flush return %d\n", now.tv_sec, (int)now.tv_usec/1000, res);
    } else {
        syslog(LOG_ERR, "open_input_stream() called before pulseaudio initialization\n");
    }
    send(ta->sock_fd, &response, 4, 0);
    return res;
}


static pa_simple *pa_create_playback(char *appname) {
    int error;
    pa_simple *s;
    static const pa_sample_spec ss_out = {
        .format = PA_SAMPLE_S16LE,
        .rate = 44100,
        .channels = 2
    };
    static const pa_buffer_attr ba_out = {
        .maxlength = 4 * 1024,
        .tlength = 4096,
        .prebuf = 4096,
        .minreq = 4096,
        .fragsize = -1
    };
    s = pa_simple_new(NULL, appname, PA_STREAM_PLAYBACK, NULL, "playback", &ss_out, NULL, NULL, &error);
    return s;
}

static pa_simple *pa_create_record(char *appname) {
    int error;
    pa_simple *s;
    static const pa_sample_spec ss_in = {
        .format = PA_SAMPLE_S16LE,
        .rate = 8000,
        .channels = 1
    };
    static const pa_buffer_attr ba_in = {
        .maxlength = 0.5 * 1024,
        .tlength = -1,
        .prebuf = -1,
        .minreq = -1,
        .fragsize = 320
    };
    s = pa_simple_new(NULL, appname, PA_STREAM_RECORD, NULL, "record", &ss_in, NULL, &ba_in, &error);
    return s;
}

static int pa_create(struct thread_args *ta, const void *buf, int size) {
    int res;
    int response = size;
    int error;
    const char *cbuf = (const char *)buf;
    int unum = ta->userId;
    int dir = *(int *)(cbuf + 4);

    send(ta->sock_fd, &response, 4, 0);

    return size;
}

static int processPacket(struct thread_args *thread_args, int op, int size, const void *buf) {
    int res = 0;
    switch(op) {
        case OP_OUT_WRITE:
            res = out_write(thread_args, (char *)buf + 4, (size_t) size - 4);
            break;
        case OP_IN_READ:
            res = in_read(thread_args, (char *)buf + 4, (size_t) size - 4);
            break;
        case OP_OPEN_INPUT_STREAM:
            res = open_input_stream(thread_args, (char *)buf + 4, (size_t) size - 4);
            break;
        case OP_PA_CREATE:
            res = pa_create(thread_args, (char *)buf + 4, (size_t) size - 4);
            break;
        default:
            syslog(LOG_INFO, "invalid opcode\n");
            res = -1;
    }
    return res;
}

static int recv(int fd, const void *buf, int size) {
    int res;
    int done = 0;
    if(size <=0) return 0;
    while(done < size) {
        res = recv(fd, (char *)buf + done, size - done, 0);
        if(res > 0) {
            done += res;
            //syslog(LOG_INFO, "recv: good responce res=%d, done=%d\n", res, done);
        } else {
            syslog(LOG_INFO, "recv: invalid responce res=%d, errno=%d\n", res, errno);
            return -1;
        }
    }
    return done;
}

static void *handler_client(void *handler_obj) {
    //Get the socket descriptor

    struct thread_args *thread_args = (struct thread_args *)handler_obj;
    int sock = thread_args->sock_fd;
    int read_size, buf_size = 12*1024+4;
    void *buf, *tmp;
    int res = 0;
    int op;
    syslog(LOG_INFO, "handler_client() client connection socket %d\n", sock);

    struct ucred ucred;
    unsigned int len = sizeof(struct ucred);
    if (getsockopt(sock, SOL_SOCKET, SO_PEERCRED, &ucred, &len) == -1) {
        res = -1;
        syslog(LOG_ERR, "Cannot accept credentials of client sock=%d, errno=%d\n", sock, errno);
    }
    syslog(LOG_INFO, "Credentials from SO_PEERCRED: sock=%d pid=%ld, euid=%ld, egid=%ld\n",
            sock, (long) ucred.pid, (long) ucred.uid, (long) ucred.gid);
    thread_args->userId = ucred.uid / 100000;
    if((ucred.uid % 100000) != 1041) {
        res = -1;
        syslog(LOG_ERR, "Cannot bad credentials of client sock=%d, errno=%d\n", sock, errno);
    }
    if(!res) {
        buf = malloc(buf_size);
    }
    if(buf != NULL) {
        while(1) {
            res = recv(sock, &read_size, 4);
            if(res != 4) {
                syslog(LOG_WARNING, "handler_client() Unexpect read size, res=%d\n", res);
                break;
            }
            if(res > buf_size) {
                tmp = realloc(buf, res);
                if(tmp == NULL) {
                    syslog(LOG_ERR, "handler_client() cannot realloc buf\n");
                    break;
                } else {
                    buf = tmp;
                }
            }
            res = recv(sock, buf, read_size);
            if(res != read_size) {
                syslog(LOG_WARNING, "handler_client() Unexpect read size, res=%d\n", res);
                break;
            }
            op = *(int *)buf;
            //syslog(LOG_DEBUG, "handler_client() packet op: %d, size %d\n", op, read_size);
            res = processPacket(thread_args, op, read_size, buf);
            if(res < 0) {
                syslog(LOG_ERR, "handler_client() processPacket of packet with op: %d, size %d return error\n", op, read_size);
                break;
            }
        }
        free(buf);
    } else {
        syslog(LOG_ERR, "handler_client() cannot malloc buf\n");
    }
    syslog(LOG_INFO, "handler_client() client disconnection, socket %d\n", sock);

    close(sock);

    delete thread_args;
    return 0;
}

static int init_socket(const char *path, int userId) {
    int res;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);

    if(fd == -1) {
        syslog(LOG_INFO, "Could not create server socket\n");
        return -1;
    }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, path);

    unlink(addr.sun_path);
    res = bind(fd, (struct sockaddr *)&addr, sizeof(addr));
    if(res < 0) {
        //print the error message
        syslog(LOG_INFO, "bind failed. errno=%d\n", errno);
        close(fd);
        return -2;
    }
    res = chmod(addr.sun_path, 0660);
    res = chown(addr.sun_path, unum*100000 + 1041, 0);

    res = listen(fd, 3);
    if(res < 0) {
        //print the error message
        syslog(LOG_INFO, "listen failed. Error\n");
        close(fd);
        return -3;
    }
    return fd;
}

static void *handle_out_server(void *handler_obj) {
    int res;
    struct server_args *sa = (struct server_args *)handler_obj;
    int client_sock;
    struct sockaddr_un addr;
    socklen_t sock_size = sizeof(struct sockaddr_un);
    char appname[32];
    pa_simple *s;

    sprintf(appname, "nubo-pulseaudio-u%d", unum);
    s = pa_create_playback(appname);

    res = init_socket(sa->path, sa->userId);
    if(res < 0) {
        syslog(LOG_ERR, "Cannot bind out socket");
        return NULL;
    } else {
        sa->sock_fd = res;
    }
    struct timeval timeout;      
    timeout.tv_sec = 10;
    timeout.tv_usec = 0;

    if (setsockopt(sa->sock_fd, SOL_SOCKET, SO_RCVTIMEO, (char *)&timeout, sizeof(timeout)) < 0)
        syslog(LOG_ERR, "setsockopt failed\n");


    while(sa->sock_fd) {
        syslog(LOG_INFO, "%s waiting for client... sock %d\n", __FUNCTION__, sa->sock_fd);
        client_sock = accept(sa->sock_fd, (struct sockaddr *)&addr, &sock_size);
        syslog(LOG_INFO, "accepted client... sock %d\n", client_sock);
        if (client_sock == -1) {
            res = errno;
            if (res == 11) continue;
            syslog(LOG_ERR, "Could not create client socket, errno=%d\n", errno);
            return NULL;
        }
        struct thread_args *thread_args = new struct thread_args(client_sock);
        thread_args->s = s;
        handler_client(thread_args);
    }
    close(sa->sock_fd);
    unlink(sa->path);
    syslog(LOG_INFO, "%s finish\n", __FUNCTION__);
    return handler_obj;
}

static void *handle_in_server(void *handler_obj) {
    int res;
    struct server_args *sa = (struct server_args *)handler_obj;
    int client_sock;
    struct sockaddr_un addr;
    socklen_t sock_size = sizeof(struct sockaddr_un);
    char appname[32];

    sprintf(appname, "nubo-pulseaudio-u%d", sa->userId);
    pa_simple *s = pa_create_record(appname);
    
    res = init_socket(sa->path, sa->userId);
    if(res < 0) {
        syslog(LOG_ERR, "Cannot bind out socket");
        return NULL;
    } else {
        sa->sock_fd = res;
    }
    struct timeval timeout;      
    timeout.tv_sec = 10;
    timeout.tv_usec = 0;

    if (setsockopt(sa->sock_fd, SOL_SOCKET, SO_RCVTIMEO, (char *)&timeout, sizeof(timeout)) < 0)
        syslog(LOG_ERR, "setsockopt failed\n");

    while(sa->sock_fd) {
        syslog(LOG_INFO, "%s waiting for client... sock %d\n", __FUNCTION__, sa->sock_fd);
        client_sock = accept(sa->sock_fd, (struct sockaddr *)&addr, &sock_size);
        if (client_sock == -1) {
            res = errno;
            if (res == 11) continue;
            syslog(LOG_ERR, "Could not create client socket, errno=%d\n", errno);
            return NULL;
        }
        struct thread_args *thread_args = new struct thread_args(client_sock);
        thread_args->s = s;
        handler_client(thread_args);
    }
    unlink(sa->path);
    syslog(LOG_INFO, "finish %s\n", __FUNCTION__);
    return handler_obj;
}

void go_background() {
    pid_t pid = fork();
    if (pid > 0) {
        exit(EXIT_SUCCESS);
    }
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    close(STDERR_FILENO);
}

int parse_args(int argc, char *argv[]) {
    bool isNum = false;
    int i, l;
    char *p;

    if(argc > 1) {
        l = strlen(argv[1]);
        if((l > 0) && (l < 3)) {
            isNum = true;
            for(i=0; i<l; i++) {
                p = &argv[1][i];
                if((*p < '0') || (*p > '9')) {
                    isNum = false;
                    break;
                }
            }
        }
        if(isNum) {
            unum = atoi(argv[1]);
        } else {
            syslog(LOG_ERR, "invalid user number");
            return -1;
        }
        if(unum == 0) {
            syslog(LOG_ERR, "user number 0 is not allowed");
            return -1;
        }
    } else {
        syslog(LOG_ERR, "missed user number");
        return -1;
    }

    server_out_args.userId = unum;
    server_in_args.userId = unum;
    sprintf(server_out_args.path, "%s_%s_%d", SOCKETPREFIX, "out", unum);
    sprintf(server_in_args.path, "%s_%s_%d", SOCKETPREFIX, "in", unum);

    return 0;
}

int main(int argc, char *argv[]) {
    int res;
    pthread_t thread_id_out;
    pthread_t thread_id_in;
    pthread_attr_t attrs;
    pthread_attr_init(&attrs);
    pthread_attr_setdetachstate(&attrs, PTHREAD_CREATE_JOINABLE);

    openlog ("pulseaudio-user", LOG_CONS | LOG_PID | LOG_NDELAY, LOG_LOCAL1);
    syslog(LOG_NOTICE, "starting pulseaudio-service");

    res = parse_args(argc, argv);
    if(res < 0) {
        return res;
    }

    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    puts("Go backgroud and start main loop!!\n");
    go_background();

    res = pthread_create(&thread_id_out, &attrs, handle_out_server, (void *) &server_out_args);
    if( res < 0) {
        syslog(LOG_ERR, "could not create thread\n");
        return -2;
    }
    
    res = pthread_create(&thread_id_in, &attrs, handle_in_server, (void *) &server_in_args);
    if( res < 0) {
        syslog(LOG_ERR, "could not create thread\n");
        return -2;
    }

    res = pthread_join(thread_id_out, NULL);
    syslog(LOG_NOTICE, "pthread_join thread_id_out return %d", res);
    res = pthread_join(thread_id_in, NULL);
    syslog(LOG_NOTICE, "pthread_join thread_id_in return %d", res);
    
    syslog(LOG_NOTICE, "pulseaudio-service finished");
    closelog();

    return 0;
}

