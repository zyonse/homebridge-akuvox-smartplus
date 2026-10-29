# homebridge-akuvox-smartplus

Open Akuvox SmartPlus doors, gates, and garage relays from Apple Home.

Each relay on your SmartPlus account becomes a HomeKit accessory: a **garage door** (default), a **momentary switch**, or a **lock**. Enter your SmartPlus email and password in the plugin settings. The plugin signs in, keeps the session refreshed, and signs in again by itself if SmartPlus ends the session.

API details come from the SmartPlus Android app and the [Akuvox SmartPlus Home Assistant integration](https://github.com/nimroddolev/akuvox).

## Install

```sh
git clone <this repo> && cd homebridge-akuvox-smartplus
npm install && npm run build
npm install -g .
```

Then open the plugin's settings in the Homebridge UI and enter your SmartPlus email, password and region.

> **SmartPlus allows only one app session per account.** Signing in from Homebridge signs the SmartPlus phone app out. If you then sign in on the phone, the plugin signs back in the next time it's used, which signs the phone out again. A separate SmartPlus family-member account for Homebridge avoids the conflict, if your building allows family members.

The plugin saves its session, but not your password, to `<storage>/akuvox-smartplus.json`, readable only by the Homebridge user. Your password stays in Homebridge's `config.json`, like other plugins that sign in to a cloud account. At startup the plugin logs every door on the account with its id, for the `doors` setting.

### Accounts that need an emailed code

Some accounts must enter a code from email when signing in. North America accounts so far haven't needed one. If the plugin logs that a code is required, sign in once from a terminal on the Homebridge host and restart Homebridge:

```sh
akuvox-smartplus-login --storage ~/.homebridge --region ucloud
```

This also supports signing in by SMS. Without a password in the settings, a session saved this way can't be renewed automatically if SmartPlus ends it.

## Configure

```json
{
  "platform": "AkuvoxSmartPlus",
  "name": "Akuvox SmartPlus",
  "options": {
    "email": "you@example.com",
    "password": "…",
    "region": "ucloud"
  },
  "defaultType": "garage",
  "doors": [
    { "name": "Garage", "openDuration": 45 },
    { "name": "Front Door", "type": "lock" },
    { "name": "Pool Gate", "hidden": true }
  ]
}
```

| Option | Description |
| --- | --- |
| `options.email` / `options.password` | SmartPlus app login |
| `options.region` | `ucloud` North America (default), `ecloud` Europe/global, `scloud`, `aucloud`, `ccloud`, `jcloud`, `rucloud`. `ecloud` is also tried automatically |
| `defaultType` | `garage` (default), `switch`, or `lock` |
| `onlyListedDoors` | Only add doors listed in `doors`. Recommended for community accounts, which can see every building door |
| `openDuration` | Seconds to show a door as open after triggering. Defaults: garage 60, switch 1, lock 10 |
| `doors[].name` | Door name, device name, or `mac:relay` id, as logged at startup. Case-insensitive. Use the id when names repeat |
| `doors[].type` / `openDuration` | Per-door overrides |
| `doors[].hidden` | Leave this relay out of HomeKit |

## How it behaves

- **SmartPlus has no door sensor.** It only fires the relay. After you open a door, the plugin shows it as open for `openDuration` seconds, then shows it as closed again. Closing it in Home only resets that displayed state and doesn't fire the relay.
- **Automations:** iOS asks for confirmation before running location-based automations that involve garage doors and locks. If you want arrival automations to run hands-free, use `"type": "switch"` for that door.
- **Sessions:** the token is refreshed every 6 hours. If a request is rejected, the plugin refreshes and retries once. If SmartPlus has ended the session entirely, the plugin signs in again with your password. After a failed sign-in it waits 10 minutes before trying again, so a wrong password can't lock the account.
- **Outages:** if SmartPlus can't be reached at startup, previously added doors stay in Home and keep working once SmartPlus is reachable again.

## Development

```sh
npm run build   # compile to dist/
npm test        # build + node --test
npm run lint
npm run watch   # rebuild and run Homebridge on change
```
