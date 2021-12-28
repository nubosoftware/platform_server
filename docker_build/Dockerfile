FROM ubuntu:20.04
RUN apt-get -y update
# install linux packages
RUN apt install -y \
    curl \
    supervisor \
    rsyslog \
    vim \
    iputils-ping \
    telnet \
    dnsutils \
    net-tools \
    sudo

# install nodejs
RUN curl -fsSL https://deb.nodesource.com/setup_16.x | bash -
RUN apt install -y nodejs

#install docker-ce-cli
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
RUN echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
RUN apt update -y ; apt install -y docker-ce-cli

# mark this as docker installation
RUN mkdir -p /etc/.nubo/ && \
    touch  /etc/.nubo/.docker

# install nubo debs
COPY debs /tmp
RUN apt install -y \
    /tmp/nubo-common.deb \
    /tmp/platform-server.deb    
    
RUN rm -f /tmp/*.deb


# configure
ADD etc /etc
ADD bin /usr/bin
RUN sed -i /imklog/s/module/#module/ /etc/rsyslog.conf

# Docker config
VOLUME ["/opt/platform_server/conf"]
EXPOSE 3333 3334
ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["supervisord"]
