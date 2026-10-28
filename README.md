# homebridge-akuvox-smartplus

Open Akuvox SmartPlus doors, gates, and garage relays from Apple Home.

Each relay on your SmartPlus account becomes a HomeKit accessory: a **garage door** (default), a **momentary switch**, or a **lock**. The plugin signs in once, then keeps its session refreshed automatically so you don't have to keep logging back in.

API details come from the [Akuvox SmartPlus Home Assistant integration](https://github.com/nimroddolev/akuvox).

## Install

```sh
git clone <this repo> && cd homebridge-akuvox-smartplus
npm install && npm run build
npm install -g .
```

## Sign in (one time)

SmartPlus sign-in needs a code sent by SMS or email, so it's done from a terminal on the Homebridge host rather than in config.json:

```sh
akuvox-smartplus-login --storage ~/.homebridge
```

- `--storage`: your Homebridge storage directory, where `config.json` lives. Defaults to `~/.homebridge`.
- `--region`: SmartPlus region. Defaults to `ucloud` (US). Other regions are `ecloud` (EU and global), `aucloud`, `ccloud`, `jcloud`, `rucloud` and `scloud`. Email sign-in also tries `ecloud` automatically.

The command prints every door relay on the account and saves the session to `<storage>/akuvox-smartplus.json`, which is readable only by your user. Restart Homebridge afterwards.

> **SmartPlus allows only one app session per account.** Signing in here will probably sign the SmartPlus phone app out, and signing back in to the phone app will end the plugin's session. In that case, run the login command again. A separate SmartPlus family-member account for Homebridge avoids the conflict, if your building allows family members.

## Configure

```json
{
  "platform": "AkuvoxSmartPlus",
  "name": "Akuvox SmartPlus",
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
| `defaultType` | `garage` (default), `switch`, or `lock` |
| `openDuration` | Seconds to show a door as open after triggering. Defaults: garage 60, switch 1, lock 10 |
| `doors[].name` | Door name, device name, or `mac:relay` id, as printed by the login command. Case-insensitive |
| `doors[].type` / `openDuration` | Per-door overrides |
| `doors[].hidden` | Leave this relay out of HomeKit |

## How it behaves

- **SmartPlus has no door sensor.** It only fires the relay. After you open a door, the plugin shows it as open for `openDuration` seconds, then shows it as closed again. Closing it in Home only resets that displayed state and doesn't fire the relay.
- **Automations:** iOS asks for confirmation before running location-based automations that involve garage doors and locks. If you want arrival automations to run hands-free, use `"type": "switch"` for that door.
- **Sessions:** the token is refreshed every 6 hours. If a request is rejected, the plugin refreshes and retries once. Refreshed tokens are saved back to the credentials file.
- **Outages:** if SmartPlus can't be reached at startup, previously added doors stay in Home and keep working once SmartPlus is reachable again.

## Development

```sh
npm run build   # compile to dist/
npm test        # build + node --test
npm run lint
npm run watch   # rebuild and run Homebridge on change
```
