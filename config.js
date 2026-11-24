// RideCom settings. This is the only file you should need to edit.
window.RIDECOM_CONFIG = {
  // ---------------------------------------------------------------------------
  // TURN server (strongly recommended for mobile data)
  // ---------------------------------------------------------------------------
  // Mobile networks often block direct phone-to-phone connections. A TURN
  // server relays the audio when that happens. Without one, the app may
  // connect on Wi-Fi but fail on 4G.
  //
  // Easiest option: create a free account at metered.ca, create a TURN app,
  // and paste its "credentials API URL" here. It looks like:
  //   https://YOUR-APP.metered.live/api/v1/turn/credentials?apiKey=XXXXXXXX
  turnCredentialsUrl: "",

  // Or list TURN servers by hand (leave empty if you use the URL above):
  // { urls: "turn:example.com:3478", username: "user", credential: "pass" }
  extraIceServers: [],

  // ---------------------------------------------------------------------------
  // You normally don't need to change anything below this line.
  // ---------------------------------------------------------------------------

  // Free public STUN servers (help phones find each other; they carry no audio).
  stunServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],

  // Signalling server that introduces the two phones. null = PeerJS's free
  // public cloud server. To use your own: { host, port, path, secure }.
  peerServer: null,

  // Prefix for connection IDs so your room codes don't clash with other apps.
  idPrefix: "ridecom-v1",
};
