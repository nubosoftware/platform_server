FROM ubuntu:20.04
ARG BUILD_VER=3.2
ARG TARGET_DIR=/opt/platform_server
RUN apt-get -y update
# install linux packages
RUN apt install -y \
    curl \
    supervisor \
    rsyslog \
    vim \
    iputils-ping \
    iptables \
    telnet \
    dnsutils \
    net-tools \
    nfs-common \
    sudo \
    pulseaudio \
    gstreamer1.0-x \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    libgstreamer1.0-0 \
    libgstreamer-plugins-good1.0-0 \
    libgstreamer-plugins-bad1.0-0 \
    gstreamer1.0-pulseaudio

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

# configure
ADD docker_build/etc /etc
ADD docker_build/bin /usr/bin
RUN sed -i /imklog/s/module/#module/ /etc/rsyslog.conf

# copy files to target dir
RUN mkdir -p ${TARGET_DIR}
COPY package.json ${TARGET_DIR}/.
COPY webpack.config.js ${TARGET_DIR}/.
ADD src ${TARGET_DIR}/src
WORKDIR ${TARGET_DIR}
RUN echo "VERSION: ${BUILD_VER}" > version.txt

# add build essential
RUN apt install -y build-essential

# prepare the module
RUN npm install

# remove build-essntial
RUN apt-get --purge autoremove -y build-essential

# remove build dependencies
RUN rm -rf src webpack.config.js

COPY dist/audiomanager.js ${TARGET_DIR}/dist/
COPY dist/pulseaudio-user ${TARGET_DIR}/dist/
COPY dist/restserver.js ${TARGET_DIR}/dist/

# Create a new user nubo
ARG UID=1000
ARG GID=1000
RUN groupadd --gid $GID nubo
RUN useradd --system --create-home --shell /bin/bash --uid $UID --gid $GID nubo


# Docker config
VOLUME ["${TARGET_DIR}/conf"]
EXPOSE 3333 3334
ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["supervisord"]
