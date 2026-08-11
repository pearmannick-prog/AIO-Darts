// main.js - the Windows desktop build.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. It is not a second copy of
// the app. It starts the SAME `server/server.js` the Docker image runs, on a
// loopback port, and points a Chromium window at it. Every rule in CLAUDE.md
// about one process and one port still holds; this just supplies the process
// and opens the window.
//
// WHY A SERVER AT ALL, when Electron can load files off disk. Because
// `file://` is not a secure context in Chromium, and Web Bluetooth is refused
// outside one - so an Electron build that loaded index.html directly would run
// perfectly and never see the Granboard, which is most of the point of playing
// darts on a machine plugged into a board. `http://127.0.0.1` IS a secure
// context. That single fact decides the whole architecture of this file, and
// it is also why Tauri was not an option: it renders in WebView2, which does
// not implement Web Bluetooth at all.
//
// The server is spawned rather than required, so its lifecycle is a process
// and killing it is unambiguous - and so a crash in it cannot take the window
// down with it.

const { app, BrowserWindow, shell, session } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const path = require("node:path");
const http = require("node:http");

// Where the front-end and the server live. Unpackaged that is the repo root,
// one level up. Packaged, electron-builder copies the repo to resources/app.
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "app")
  : path.join(__dirname, "..");

// The deployment this build signs in to. The desktop app is a CLIENT of
// aiodarts.com: accounts, statistics, friends and the lobby all live there and
// are forwarded by server/apiproxy.js, so the page stays same-origin with its
// own API and `accountstore.js` needs no idea any of this is happening.
const UPSTREAM = "https://aiodarts.com";

// Signaling is pointed straight at production rather than proxied, because it
// needs no cookie and a WebSocket is not subject to CORS - and because a match
// has to be brokered somewhere both players can reach. A challenge code minted
// here would only ever be joinable from this machine.
const SIGNALING_URL = "wss://aiodarts.com/signaling";

let serverProcess = null;
let mainWindow = null;

// The live `select-bluetooth-device` callback, and the deadline for answering
// it. Held at module scope because the decision to answer is made across
// several fires of the event rather than inside any one of them - see the
// handler in createWindow().
let bluetoothCallback = null;
let bluetoothTimer = null;

// Answer the chooser exactly once. `deviceId` selects a board; "" cancels.
// Guarded because Electron treats a second answer to the same request as an
// error, and there are three ways to get here: a device was found, the scan
// timed out, or the window went away mid-scan.
function answerBluetooth(deviceId) {
  if (bluetoothTimer) {
    clearTimeout(bluetoothTimer);
    bluetoothTimer = null;
  }
  const callback = bluetoothCallback;
  bluetoothCallback = null;
  if (callback) callback(deviceId);
}

// Ask the OS for a free port by binding zero and looking at what we got. Fixed
// ports are how a desktop app collides with whatever else the player happens
// to be running - and this app's own start-aio-darts.bat uses 8000, which is
// exactly the sort of thing someone might have open beside it.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Spawn server/server.js using Electron's OWN Node, via ELECTRON_RUN_AS_NODE.
// That is what lets the packaged app run on a machine with no Node installed -
// the alternative, shelling out to `node`, is the one dependency a desktop
// build must not have.
function startServer(port) {
  const child = spawn(
    process.execPath,
    [path.join(APP_ROOT, "server", "server.js")],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(port),
        // Loopback ONLY. This server exists to give our own window a secure
        // context; it is not a service anyone else should find. Left on all
        // interfaces it would offer the local network a signaling relay and an
        // unauthenticated forwarder to the upstream site.
        HOST: "127.0.0.1",
        // The front-end is served from the repo root, not a build directory -
        // this app has no build step and that is deliberate.
        PUBLIC_DIR: APP_ROOT,
        // No local database. Accounts are not absent, they are ELSEWHERE, and
        // apiproxy.js checks for the upstream before it checks this - so the
        // combination below means "forward everything" rather than "503".
        ACCOUNTS: "off",
        UPSTREAM_ORIGIN: UPSTREAM,
        SIGNALING_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  // The boot log is the only place that says which state the server is in -
  // which upstream it forwards to, whether the build is known. Worth having in
  // the terminal when this is run unpackaged.
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  child.on("exit", (code) => {
    if (code !== 0 && !app.isQuittingForReal) {
      console.error(`[server] exited with code ${code}`);
    }
  });

  return child;
}

// Poll /healthz until the server answers. Loading the window before the port
// is listening gives a Chromium error page rather than a retry, and the player
// would have to know to refresh a window with no address bar.
function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/healthz", timeout: 1000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        }
      );
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error("server did not start in time"));
      else setTimeout(attempt, 150);
    };
    attempt();
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1c1c1c",
    title: "AIO Darts",
    // The PWA icon, reused rather than duplicated - one dartboard, and it
    // cannot drift from the one the web app shows. Only affects the window and
    // taskbar when run unpackaged; the packaged .exe carries the icon
    // electron-builder converts from this same file.
    icon: path.join(APP_ROOT, "icon-512.png"),
    autoHideMenuBar: true,
    webPreferences: {
      // Nothing in the front-end wants Node, and this page talks to the
      // internet. The app is plain ES modules over HTTP - it needs no bridge,
      // so it gets none.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // THE HANDLER WITHOUT WHICH BLUETOOTH SILENTLY NEVER WORKS. Electron ships
  // no device chooser, so `navigator.bluetooth.requestDevice()` sits unresolved
  // forever unless this event is answered - the board never appears and there
  // is no error anywhere to explain it.
  //
  // THE EVENT FIRES REPEATEDLY, once per discovery update, and the FIRST fire
  // routinely carries an empty list because scanning has not turned anything up
  // yet. That is the trap: answering "" means *cancel*, so replying to that
  // first empty fire aborts the chooser milliseconds after it opens, and the
  // page is told "User cancelled the requestDevice() chooser" when the user did
  // nothing of the kind and the board was never given a chance to appear.
  // An empty list means KEEP WAITING - hold the callback and say nothing.
  //
  // Picking the first device is safe here specifically because granboard.js
  // filters by the Granboard service UUID, so Chromium has already excluded
  // everything that is not a board. With two boards in range this would guess,
  // which is a real limitation and the place a chooser window would go.
  mainWindow.webContents.on("select-bluetooth-device", (event, devices, callback) => {
    event.preventDefault();

    // Each fire supplies its own callback, and only the most recent one is
    // live. Answering a superseded one does nothing.
    bluetoothCallback = callback;

    if (devices.length > 0) {
      const board = devices[0];
      console.log(`[bluetooth] selecting ${board.deviceName || "(unnamed)"} ${board.deviceId}`);
      answerBluetooth(board.deviceId);
      return;
    }

    // Give up eventually rather than leaving "Connecting..." on screen for
    // ever. Started on the first fire only, so discovery updates don't keep
    // pushing the deadline back. Thirty seconds is long enough to walk over
    // and switch a board on, which is the usual reason it isn't there yet.
    if (!bluetoothTimer) {
      bluetoothTimer = setTimeout(() => {
        console.log("[bluetooth] no board found within 30s - cancelling");
        answerBluetooth("");
      }, 30_000);
    }
  });

  // Camera and mic for online play, and Bluetooth. Electron denies these by
  // default for a loaded page; the app is our own server on loopback, so the
  // question is only ever about hardware the player just asked for.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, done) => {
    done(["media", "bluetooth", "notifications", "fullscreen"].includes(permission));
  });

  // Links out - the source repo, the licence, anything in the About sheet -
  // belong in the player's real browser, not in a darts window with no
  // address bar and no way back.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.on("closed", () => {
    // A scan left running against a window that no longer exists holds the
    // radio and leaves a timer alive for half a minute after the app looks
    // shut. Cancel it rather than let it answer into nothing.
    answerBluetooth("");
    mainWindow = null;
  });
}

// Updates matter here more than for most desktop apps, and the reason is the
// sync strategy rather than convenience. The accounts, lobby, signaling and
// TURN halves are forwarded to production and so are always current - but the
// FRONT-END is baked into the package at build time, and the front-end is where
// the pure rules live. Determinism is what keeps two browsers in step; an
// installed copy that never updates is a peer running a different version of
// the rules against a web player who has the newest, which is exactly the
// silent disagreement the whole design is built to avoid.
//
// INSTALL ON QUIT, NEVER MID-SESSION. electron-updater's default is to download
// in the background and apply on exit, which is the only acceptable behaviour
// for something someone is standing at a board using: restarting the app
// between visits would end a match. `checkForUpdatesAndNotify` surfaces a
// native notification rather than a dialog, so nothing steals focus from a
// throw either.
function startUpdater() {
  // Only a packaged build has anything to update, and asking in development
  // just produces an error about a missing app-update.yml.
  if (!app.isPackaged) return;

  autoUpdater.logger = {
    info: (m) => console.log(`[updater] ${m}`),
    warn: (m) => console.warn(`[updater] ${m}`),
    error: (m) => console.error(`[updater] ${m}`),
    debug: () => {},
  };

  autoUpdater.on("update-downloaded", ({ version }) => {
    console.log(`[updater] ${version} ready - installing when the app quits`);
  });
  // Never fatal. No network, a rate-limited API, a release that isn't there
  // yet: none of those are reasons to interrupt someone playing darts, and the
  // app is completely usable without ever seeing an update.
  autoUpdater.on("error", (err) => {
    console.warn(`[updater] check failed: ${err?.message || err}`);
  });

  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

app.whenReady().then(async () => {
  const port = await freePort();
  serverProcess = startServer(port);
  try {
    await waitForServer(port);
  } catch (err) {
    console.error(err.message);
  }
  createWindow(port);

  // After the window, deliberately. The board and the scoreboard are what
  // someone opened this for; an update check is never worth a slower start.
  startUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

// Stop means stop. A server left running holds the port and keeps a lobby
// socket open to production after the window has gone - the same reasoning
// webrtc.js applies to a camera light that stays on.
function stopServer() {
  app.isQuittingForReal = true;
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

app.on("window-all-closed", () => {
  stopServer();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", stopServer);
process.on("exit", stopServer);
