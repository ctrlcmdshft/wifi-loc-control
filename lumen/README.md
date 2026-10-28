# Lumen

Lumen is a cabin display for a Tesla browser. A laptop on the same Wi-Fi serves two pages: the car screen, and a phone remote. The phone can lock or switch apps. Playback stays on the car.

It is a separate app from WiFiLocControl.

## What it does

TeslaDisplay mirrors a phone onto the car’s browser. Lumen keeps that idea and adds a screen that is built for the car:

- **Drive** is the default. A clock, destination, and trip timer. Video stays hidden.
- **Theater** plays a queue of your files, direct video links, and YouTube. The car asks before it shows a picture. That confirmation is for a passenger, or while the car is parked.
- **Mirror** shows the phone’s screen, which is the practical way to put a map on the car display. Android Chrome and desktop Chrome can share. An iPhone browser cannot capture its screen; the queue still works.
- **Ambient**, **Frame**, and **Trip** are a quiet clock, a photo loop, and a shared checklist with notes.
- Playlists, shuffle, loop, speed, volume, and subtitles (a `.vtt` file).
- The phone and the car stay in sync over the local network. No account, no VPN, and no extra hop for files that live on the laptop.

The person driving watches the road. Video on the center screen is for a passenger, or for when the car is parked.

## Run it

```bash
cd lumen
npm install
npm start
```

The terminal prints the addresses. By default the car page is port **4747** and the secure remote is port **4748**.

1. Connect the laptop and the Tesla to the same Wi-Fi. A phone hotspot works: the laptop and the car both join the phone.
2. In the Tesla browser, open the `http://…:4747` address. If the page drops out in gear, turn on **Remain connected in Drive** in the car’s Wi-Fi settings.
3. On the phone, open `/remote` or scan the code behind **Remote** on the car screen.
4. To share the phone’s screen, open the `https://…:4748/remote` address and accept the certificate warning once. Tap **Share screen**. Pair the phone to the car with Bluetooth if you want that screen’s audio. The queue plays its own audio in the browser.

An mp4 that uses H.264 is the format the car browser plays most reliably. YouTube plays when the car has a network connection. Files on the laptop do not need one.

Anyone on the same Wi-Fi can open the remote. Use a private hotspot, not a public network.

## Checks

```bash
npm test
```
