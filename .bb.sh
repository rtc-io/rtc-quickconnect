set -e

# bootstrap the build
mkdir -p .travis
curl -s https://codeload.github.com/rtc-io/webrtc-testing-on-travis/tar.gz/master | tar -xz --strip-components=1 --directory .travis
export DISPLAY=:99.0
sh -e /etc/init.d/xvfb start

# install deps and run the test command
npm install
npm test
