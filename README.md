# The Platform Server

It is part of the [Linux Remote Desktop](https://github.com/nubosoftware/linux-remote-desktop) system.

Manages the users' containers in each server.

Runs in each server and gets commands from the management component regarding users logging in or out, and then starts or stops the containers using the parameters recieved from the management component.

Sends health information and performance statistics to the management server.

### Build Instructions
```
git clone git@github.com:nubosoftware/platform_server.git
cd platform_server/
npm install --only=dev
mkdir dist
make docker
```
