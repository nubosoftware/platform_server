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

#define BUFSIZE 1024
#define OP_OUT_WRITE 1
#define OP_PA_CREATE 100
#define SOCKETFILE "/Android/sound-hal.sock"

void *connection_handler(void *);
static int binder_fd = 0;

struct thread_args {
    int sock_fd;
    pa_simple *s;
    thread_args(int fd): sock_fd(fd), s(NULL) {}
};

void sig_handler(int signo)
{
    switch(signo) {
        case SIGINT:
        case SIGTERM:
            syslog(LOG_NOTICE, "signal %d has been received x\n", signo);
            close(binder_fd);
            binder_fd = 0;
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

    gettimeofday(&now, NULL);
    if(ta->s) {
        res = pa_simple_write(ta->s, buf, size, &error);
        syslog(LOG_DEBUG, "time: %ld.%03d out_write: size=%d, pa_simple_write  return %d\n", now.tv_sec, (int)now.tv_usec/1000, size, res);
    } else {
        syslog(LOG_ERR, "out_write() called before pulseaudio initialization\n");
    }
    //send(ta->sock_fd, &response, 4, 0);
    return res;
}

static int pa_create(struct thread_args *ta, const void *buf, int size) {
    int res;
    int response = size;
    int error;
    int unum = *(int *)buf;
    char appname[32];
    pa_simple *s;
    static const pa_sample_spec ss = {
        .format = PA_SAMPLE_S16LE,
        .rate = 44100,
        .channels = 2
    };

    sprintf(appname, "nubo-pulseaudio-u%d", unum);
    s = pa_simple_new(NULL, appname, PA_STREAM_PLAYBACK, NULL, "nubo0", &ss, NULL, NULL, &error);
    if (s) {
        ta->s = s;
    } else {
        fprintf(stderr, __FILE__": pa_simple_new() failed: %s\n", pa_strerror(error));
        return -1;
    }
    return size;
}

static int processPacket(struct thread_args *thread_args, int op, int size, const void *buf) {
    int res = 0;
    switch(op) {
        case OP_OUT_WRITE:
            res = out_write(thread_args, (char *)buf + 4, (size_t) size - 4);
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
    int read_size, buf_size = 4100;
    void *buf;
    int res;
    int op;
    syslog(LOG_INFO, "handler_client() client connection\n");
    buf = malloc(buf_size);
    if(buf != NULL) {
        while(binder_fd) {
            res = recv(sock, &read_size, 4);
            if(res != 4) {
                syslog(LOG_WARNING, "handler_client() Unexpect read size, res=%d\n", res);
                break;
            }
            res = recv(sock, buf, read_size);
            if(res != read_size) {
                syslog(LOG_WARNING, "handler_client() Unexpect read size, res=%d\n", res);
                break;
            }
            op = *(int *)buf;
            syslog(LOG_DEBUG, "handler_client() packet op: %d, size %d\n", op, read_size);
            res = processPacket(thread_args, op, read_size, buf);
            if(res < 0) break;
        }
    }
    syslog(LOG_INFO, "handler_client() client disconnection\n");

    free(buf);
    close(sock);

    if (thread_args->s) pa_simple_free(thread_args->s);
    delete thread_args;
    return 0;
}

static int wait_for_connection(int fd) {
    int res;
    int client_sock;
    struct sockaddr_in addr;
    pthread_t thread_id;
    socklen_t sock_size = sizeof(struct sockaddr_in);
    
    if(fd == 0) return 0;
    syslog(LOG_INFO, "waiting for client...\n");
    client_sock = accept(fd, (struct sockaddr *)&addr, &sock_size);
    if (client_sock == -1) {
        syslog(LOG_ERR, "Could not create socket\n");
        return -1;
    }
    struct thread_args *thread_args = new struct thread_args(client_sock);
    res = pthread_create(&thread_id, NULL, handler_client, (void*) thread_args);
    if( res < 0) {
        syslog(LOG_ERR, "could not create thread\n");
        close(client_sock);
        delete thread_args;
        return -2;
    }
    return 0;
}

static int init_socket() {
    int res;
    //int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    binder_fd = socket(AF_INET, SOCK_STREAM, 0);

    if(binder_fd == -1) {
        syslog(LOG_INFO, "Could not create socket\n");
        return -1;
    }
    //struct sockaddr_un addr;
    //memset(&addr, 0, sizeof(addr));
    //addr.sun_family = AF_UNIX;
    //strcpy(addr.sun_path, SOCKETFILE);

    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(8888);

    res = bind(binder_fd, (struct sockaddr *)&addr, sizeof(addr));
    if(res < 0) {
        //print the error message
        syslog(LOG_INFO, "bind failed. Error\n");
        close(binder_fd);
        return -2;
    }

    res = listen(binder_fd, 3);
    if(res < 0) {
        //print the error message
        syslog(LOG_INFO, "listen failed. Error\n");
        close(binder_fd);
        return -3;
    }
    return binder_fd;
    
     
    //Accept and incoming connection
    
    while(binder_fd) {
        wait_for_connection(binder_fd);
    }
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

int main(int argc, char*argv[]) {
    int res;
    int error;

    openlog ("pulseaudio-service", LOG_CONS | LOG_PID | LOG_NDELAY, LOG_LOCAL1);

    syslog(LOG_NOTICE, "starting pulseaudio-service");
    syslog(LOG_INFO, "init_socket\n");
    res = init_socket();
    if(res < 0) {
        syslog(LOG_ERR, "Cannot bind port");
        return -2;
    }

    go_background();

    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);
    while(binder_fd) {
        wait_for_connection(binder_fd);
    }
    syslog(LOG_NOTICE, "pulseaudio-service finished");
    closelog();

    return 0;
}

