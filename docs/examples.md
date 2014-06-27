## Example Usage (using data channels)

When working with WebRTC data channels, you can call the `createDataChannel` function helper that is attached to the object returned from the `quickconnect` call.  The `createDataChannel` function signature matches the signature of the `RTCPeerConnection` `createDataChannel` function.

At the minimum it requires a label for the channel, but you can also pass through a dictionary of options that can be used to fine tune the data channel behaviour.  For more information on these options, I'd recommend having a quick look at the WebRTC spec:

<http://dev.w3.org/2011/webrtc/editor/webrtc.html#dictionary-rtcdatachannelinit-members>

If in doubt, I'd recommend not passing through options.

<<< examples/datachannel.js

## Example Usage (using captured media)

Another example is displayed below, and this example demonstrates how to use `rtc-quickconnect` to create a simple video conferencing application:

<<< examples/conference.js
