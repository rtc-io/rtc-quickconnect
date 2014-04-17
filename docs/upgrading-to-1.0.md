# rtc-quickconnect 1.0 Upgrade Guide

There have been some reasonably significant changes in the upgrade to `rtc-quickconnect@1.0`.  Primarily this has been around the different events that are emitted by quickconnect, and also the arguments that are passed to events.

With regards to the arguments passed to events, we have looked to standardize with all events including the `id` of the relevant peer being the first argument in all cases.  Where there were old events with a different format those have been removed and replaced with new events.

The following table lists a mapping for old to new events:


| Old Event | New Event |
|-----------|-----------|
| `peer:connect` | `call:started` |
| `peer:leave`   | `call:ended` **NOTE:** `peer:leave` still fires, but `call:ended` is a better choice in most cases |
| `%label%:open` | `channel:opened:%label%` |
| `%label%:close` | `channel:closed:%label%` |

In addition to these changes, there are a number of new events that are also documented in the [README](https://github.com/rtc-io/rtc-quickconnect#events):

General data channel events:

- `channel:opened`
- `channel:closed`

Media Stream Events

- `stream:added`
- `stream:removed`

That's pretty much it, you just need to ensure that your event handlers match the new format (again, see the events documentation in the README) and everything should work just fine.
