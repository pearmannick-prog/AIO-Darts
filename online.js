// online.js - 1v1 online challenges over WebRTC.
//
// Key idea: both browsers run the exact same deterministic scoring logic
// (resolveThrow from scoring.js). Each side only ever applies hits from its
// OWN physical board locally, and forwards every hit to the peer as a
// message. The peer applies that incoming hit to its model of "the opponent"
// using the identical rules. As long as messages arrive in order (which
// WebRTC DataChannels guarantee by default), both browsers' game state stays
// in lockstep with no need for a rollback/replay system - see the
// architecture notes in the top-level README.

import { Granboard, SegmentID, SegmentType, createSegment } from "./granboard.js";
import { resolveThrow, rulesFor } from "./scoring.js";
import {
  createCricketPlayer, resolveCricketThrow, applyCricketResult,
  checkCricketWin, describeCricketResult,
} from "./cricket.js";
import {
  createMatch, currentLegConfig, recordLegWin, advanceLeg,
  startingPlayerForLeg, legProgressText, normalizeLeg, MATCH_PRESETS, matchScoreText,
} from "./medley.js";
import { renderCricketBoard, wireCricketBoard } from "./cricketboard.js";
import { createQuickEntry } from "./quickentry.js";
import { renderDartboard, moveMarkerTo, hideMarker } from "./dartboard.js";

const STARTING_SCORE = 501;

let PeerLink; // lazy-imported so a missing webrtc.js doesn't break local mode
let peerLink = null;
let myBoard = null;

const online = {
  active: false,
  role: null, // 'host' | 'guest'
  activeSide: null, // 'me' | 'opp'
  gameOver: false, // the LEG is decided
  legOver: false, // leg decided but the match continues
  iWon: null,
  // The match format is chosen by the host and sent to the guest on connect
  // (see the "match_config" message) - otherwise both sides would guess, and
  // a guest could end up playing 501 while the host played Cricket.
  match: null,
  legConfig: null,
  gameType: "x01",
  // Absolute player indices in the match: host is 0, guest is 1. Both sides
  // need the same numbering so leg tallies and who-throws-first agree.
  myIndex: 0,
  oppIndex: 1,
  me: null,
  opp: null,
  log: [],
};

// ---------- DOM ----------
const el = {
  tabLocal: document.getElementById("tab-local"),
  tabOnline: document.getElementById("tab-online"),
  localMode: document.getElementById("local-mode"),
  onlineMode: document.getElementById("online-mode"),

  signalingUrl: document.getElementById("signaling-url"),
  createBtn: document.getElementById("create-challenge-btn"),
  joinInput: document.getElementById("join-code-input"),
  joinBtn: document.getElementById("join-challenge-btn"),

  setupPanel: document.getElementById("online-setup-panel"),
  waitingPanel: document.getElementById("online-waiting-panel"),
  gamePanel: document.getElementById("online-game-panel"),
  codeDisplay: document.getElementById("challenge-code-display"),
  cancelBtn: document.getElementById("cancel-challenge-btn"),

  statusLabel: document.getElementById("online-status-label"),
  meBox: document.getElementById("online-me-box"),
  oppBox: document.getElementById("online-opp-box"),
  meScore: document.getElementById("online-me-score"),
  oppScore: document.getElementById("online-opp-score"),
  turnLabel: document.getElementById("online-turn-label"),
  turnDarts: document.getElementById("online-turn-darts"),
  winnerBanner: document.getElementById("online-winner-banner"),

  connectBtn: document.getElementById("online-connect-btn"),
  connectionDot: document.getElementById("online-connection-dot"),
  connectionLabel: document.getElementById("online-connection-label"),

  manualSection: document.getElementById("online-manual-section"),
  dartboardEl: document.querySelector("#online-mode .dartboard"),
  dartboardMarker: document.getElementById("online-dartboard-marker"),
  formatSelect: document.getElementById("online-format"),
  cricketBoard: document.getElementById("online-cricket-board"),
  matchBar: document.getElementById("online-match-bar"),
  nextLegBtn: document.getElementById("online-next-leg-btn"),
  manualPerdart: document.getElementById("online-manual-perdart"),
  manualQuickTotal: document.getElementById("online-manual-quicktotal"),
  manualRing: document.getElementById("online-manual-ring"),
  manualSections: document.getElementById("online-manual-sections"),
  manualBull: document.getElementById("online-manual-bull"),
  manualDblBull: document.getElementById("online-manual-dblbull"),
  manualMiss: document.getElementById("online-manual-miss"),

  throwLog: document.getElementById("online-throw-log"),
};

// ---------- Signaling / ICE configuration ----------
// The signaling WebSocket is served by the SAME origin as this page (see
// server/server.js), so the correct URL can just be derived from
// window.location. That's why there's nothing to configure: whatever
// hostname, port, and scheme the player loaded the page on is already the
// right answer, and because the scheme is derived too (https -> wss), it can
// never be blocked as mixed content.
//
// Priority: an explicit override this browser saved > an explicit
// signalingUrl from the deployment's /config.json (only set if an operator
// deliberately points players at some OTHER server) > this same origin.
function sameOriginSignalingUrl(path = "/signaling") {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path}`;
}

// ICE servers tell WebRTC how to punch through NAT. STUN (the default) lets
// each browser learn its own public address so the two can connect directly.
// TURN is a relay for networks that refuse direct P2P entirely - it's
// optional, configured server-side, and arrives here via /config.json.
let iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];

let signalingPath = "/signaling";
const savedUrl = localStorage.getItem("granboard-signaling-url");
el.signalingUrl.value = savedUrl || sameOriginSignalingUrl();
el.signalingUrl.placeholder = sameOriginSignalingUrl();

fetch("./config.json")
  .then((res) => (res.ok ? res.json() : Promise.reject()))
  .then((cfg) => {
    if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
      iceServers = cfg.iceServers;
    }
    if (cfg.signalingPath) {
      signalingPath = cfg.signalingPath;
      el.signalingUrl.placeholder = sameOriginSignalingUrl(signalingPath);
    }
    // Only override the field if the deployment named a specific server AND
    // this browser hasn't set its own override.
    if (!savedUrl) {
      el.signalingUrl.value = cfg.signalingUrl || sameOriginSignalingUrl(signalingPath);
    }
  })
  .catch(() => {
    // No config.json (e.g. opening index.html straight off disk) - the
    // same-origin default is already in the field, so there's nothing to do.
  });

// Remembers an override only when the player actually typed something
// different from the derived default, so a saved value from an older version
// can't get stuck overriding a perfectly good same-origin URL forever.
function rememberSignalingOverride() {
  const value = el.signalingUrl.value.trim();
  if (!value || value === sameOriginSignalingUrl(signalingPath)) {
    localStorage.removeItem("granboard-signaling-url");
  } else {
    localStorage.setItem("granboard-signaling-url", value);
  }
}

function currentSignalingUrl() {
  return el.signalingUrl.value.trim() || sameOriginSignalingUrl(signalingPath);
}

// ---------- Tab switching ----------
el.tabLocal.addEventListener("click", () => switchTab("local"));
el.tabOnline.addEventListener("click", () => switchTab("online"));

function switchTab(which) {
  el.tabLocal.classList.toggle("active", which === "local");
  el.tabOnline.classList.toggle("active", which === "online");
  el.localMode.classList.toggle("hidden", which !== "local");
  el.onlineMode.classList.toggle("hidden", which !== "online");
}

// ---------- Manual entry buttons (generated once) ----------
function manualSegmentFromRing(section, ringType) {
  const ringToSlot = { inner: 0, triple: 1, outer: 2, double: 3 };
  return createSegment((section - 1) * 4 + ringToSlot[ringType]);
}

for (let section = 1; section <= 20; section++) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "manual-section-btn";
  btn.textContent = section;
  btn.addEventListener("click", () => {
    onLocalHit(manualSegmentFromRing(section, el.manualRing.value));
  });
  el.manualSections.appendChild(btn);
}
el.manualBull.addEventListener("click", () => onLocalHit(createSegment(SegmentID.BULL)));
el.manualDblBull.addEventListener("click", () => onLocalHit(createSegment(SegmentID.DBL_BULL)));
el.manualMiss.addEventListener("click", () => onLocalHit(createSegment(SegmentID.MISS)));

el.manualSection.querySelectorAll(".entry-mode-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const mode = tab.dataset.mode;
    el.manualSection.querySelectorAll(".entry-mode-tab").forEach((t) => t.classList.toggle("active", t === tab));
    el.manualPerdart.classList.toggle("hidden", mode !== "perdart");
    el.manualQuickTotal.classList.toggle("hidden", mode !== "quicktotal");
  });
});

createQuickEntry(el.manualQuickTotal, onLocalQuickTotal);

// ---------- Clickable dartboard ----------
// Same board and same code path as local mode (see dartboard.js) - clicking a
// segment routes through onLocalHit exactly like a real Bluetooth hit or a
// manual-entry button, so turn enforcement, scoring, bust detection, and the
// throw log all behave identically regardless of which input you use.
renderDartboard(el.dartboardEl, (segmentId) => {
  onLocalHit(createSegment(segmentId));
});

// The host picks the format; the guest is told it over the wire, so this is
// only ever read on the host side.
function selectedOnlineLegs() {
  const key = el.formatSelect?.value || "single-501";
  return (MATCH_PRESETS[key] || MATCH_PRESETS["single-501"]).map(normalizeLeg);
}

// Same cricket board component as local play, so the two modes can't drift.
wireCricketBoard(el.cricketBoard, (segment) => {
  if (online.gameType !== "cricket") return;
  onLocalHit(segment);
});

el.nextLegBtn?.addEventListener("click", () => {
  if (!online.legOver) return;
  // Tell the opponent first, then advance locally - both sides run the same
  // deterministic step, so neither needs to be sent the resulting state.
  peerLink?.sendGameMessage({ type: "next_leg" });
  advanceLeg(online.match);
  startOnlineLeg();
  el.winnerBanner.classList.add("hidden");
  renderOnline();
});

// ---------- Create / Join ----------
el.createBtn.addEventListener("click", async () => {
  await ensurePeerLinkLoaded();
  rememberSignalingOverride();
  peerLink = new PeerLink(currentSignalingUrl(), iceServers);
  wirePeerLink();

  el.setupPanel.classList.add("hidden");
  el.waitingPanel.classList.remove("hidden");

  try {
    const code = await peerLink.createChallenge();
    el.codeDisplay.textContent = code;
  } catch (err) {
    alert(`Couldn't create a challenge: ${err.message}`);
    el.waitingPanel.classList.add("hidden");
    el.setupPanel.classList.remove("hidden");
  }
});

el.joinBtn.addEventListener("click", async () => {
  const code = el.joinInput.value.trim();
  if (!code) return;

  await ensurePeerLinkLoaded();
  rememberSignalingOverride();
  peerLink = new PeerLink(currentSignalingUrl(), iceServers);
  wirePeerLink();

  el.setupPanel.classList.add("hidden");
  el.waitingPanel.classList.remove("hidden");
  el.codeDisplay.textContent = code.toUpperCase();

  try {
    await peerLink.joinChallenge(code);
  } catch (err) {
    alert(`Couldn't join that challenge: ${err.message}`);
    el.waitingPanel.classList.add("hidden");
    el.setupPanel.classList.remove("hidden");
  }
});

el.cancelBtn.addEventListener("click", () => {
  peerLink?.close();
  peerLink = null;
  el.waitingPanel.classList.add("hidden");
  el.setupPanel.classList.remove("hidden");
});

async function ensurePeerLinkLoaded() {
  if (!PeerLink) {
    ({ PeerLink } = await import("./webrtc.js"));
  }
}

function wirePeerLink() {
  peerLink.onStatusChange = (status) => {
    el.statusLabel.textContent = statusText(status);

    if (status === "connected" && !online.active) {
      // The guest announces itself and the host replies with the format.
      // Doing it in that order removes any race over whether the data
      // channel was open when the config was sent - the host only sends
      // once it has heard from the guest.
      if (peerLink.role === "guest") {
        peerLink.sendGameMessage({ type: "hello" });
      }
    }
    if (status === "disconnected" || status === "room-full") {
      if (online.active) {
        el.statusLabel.textContent = "Opponent disconnected.";
      }
    }
  };

  peerLink.onMessage = (msg) => {
    if (msg.type === "hello") {
      // Only the host answers this, and only once.
      if (peerLink.role !== "host" || online.active) return;
      const legs = selectedOnlineLegs();
      peerLink.sendGameMessage({ type: "match_config", legs });
      startOnlineGame("host", legs);
      renderOnline();
      return;
    }

    if (msg.type === "match_config") {
      if (online.active) return;
      startOnlineGame("guest", msg.legs);
      renderOnline();
      return;
    }

    if (msg.type === "dart") {
      applyThrow("opp", msg.segment);
    } else if (msg.type === "end_turn") {
      if (online.activeSide === "opp") {
        endTurn("opp");
        renderOnline();
      }
    } else if (msg.type === "quick_total") {
      applyQuickTotalThrow("opp", msg.value);
    } else if (msg.type === "next_leg") {
      // Either player can move the match on; both sides advance together.
      if (!online.legOver) return;
      advanceLeg(online.match);
      startOnlineLeg();
      el.winnerBanner.classList.add("hidden");
      renderOnline();
    }
  };
}

function statusText(status) {
  switch (status) {
    case "connecting-to-server": return "Connecting to signaling server…";
    case "waiting-for-opponent": return "Waiting for opponent to join…";
    case "joining": return "Joining challenge…";
    case "connected": return "Connected - good luck!";
    case "disconnected": return "Disconnected.";
    case "room-full": return "That challenge code is already in use.";
    default: return "";
  }
}

// Briefly flashes a message in the status line so an out-of-turn attempt is
// obvious to the person who tried it, instead of a silent console.warn.
let noticeTimeout = null;
function showNotice(message) {
  clearTimeout(noticeTimeout);
  el.statusLabel.textContent = message;
  el.statusLabel.style.color = "#B7302A";
  noticeTimeout = setTimeout(() => {
    el.statusLabel.style.color = "";
    el.statusLabel.textContent = online.gameOver
      ? statusText("connected")
      : online.activeSide === "me" ? "Your turn" : "Opponent's turn";
  }, 2200);
}

// ---------- Game start ----------
// Builds one player's state for a leg. x01 and Cricket keep completely
// different shapes, which is why this is a function rather than a literal.
function buildOnlinePlayer(name, legConfig) {
  if (legConfig.game === "cricket") return createCricketPlayer(name);
  const rules = rulesFor(legConfig.rules);
  return {
    name,
    remaining: legConfig.score,
    startOfTurn: legConfig.score,
    // Double-in: nothing scores until this player lands a double.
    opened: rules.in !== "double",
    dartsThisTurn: [],
  };
}

function startOnlineGame(role, legs) {
  online.active = true;
  online.role = role;
  online.myIndex = role === "host" ? 0 : 1;
  online.oppIndex = 1 - online.myIndex;
  online.match = createMatch(legs, 2);
  online.log = [];

  startOnlineLeg();

  el.waitingPanel.classList.add("hidden");
  el.gamePanel.classList.remove("hidden");
  el.winnerBanner.classList.add("hidden");
  renderOnline();
}

// Resets scores for a new leg. The match tally and player identities carry
// over; only the leg's own state is rebuilt.
function startOnlineLeg() {
  const leg = normalizeLeg(currentLegConfig(online.match));
  online.legConfig = leg;
  online.gameType = leg.game;

  online.me = buildOnlinePlayer("You", leg);
  online.opp = buildOnlinePlayer("Opponent", leg);
  online.me.dartsThisTurn = [];
  online.opp.dartsThisTurn = [];

  // Throw alternates each leg, and both sides compute it from the same
  // absolute index so they never disagree about whose turn it is.
  const starter = startingPlayerForLeg(online.match.currentLeg, 2);
  online.activeSide = starter === online.myIndex ? "me" : "opp";

  online.gameOver = false;
  online.legOver = false;
  online.iWon = null;
}

// A leg has been won. Both sides run this independently off the same inputs,
// so neither has to be told the result.
function finishOnlineLeg(side) {
  online.gameOver = true;
  online.iWon = side === "me";
  const winnerIndex = side === "me" ? online.myIndex : online.oppIndex;
  recordLegWin(online.match, winnerIndex);
  online.legOver = !online.match.over;
}

// ---------- My physical board ----------
el.connectBtn.addEventListener("click", async () => {
  if (!navigator.bluetooth) {
    if (!window.isSecureContext) {
      alert(
        "Web Bluetooth needs a secure context - it's blocked because this page is loaded over plain HTTP. " +
        "This works on http://localhost, but NOT on a plain http://<ip-address> address like this one, even on your own network. " +
        "Put the site behind HTTPS (e.g. a reverse proxy with a TLS cert) to fix this - see the README."
      );
    } else {
      alert("This browser doesn't support Web Bluetooth. Use Chrome or Edge on desktop.");
    }
    return;
  }
  try {
    el.connectionLabel.textContent = "Connecting…";
    myBoard = await Granboard.connect();
    el.connectionDot.classList.add("connected");
    el.connectionLabel.textContent = `Connected: ${myBoard.deviceName}`;

    myBoard.segmentHitCallback = (segment) => {
      if (segment.id === SegmentID.RESET_BUTTON) {
        onLocalEndTurn();
        return;
      }
      onLocalHit(segment);
    };
    myBoard.disconnectCallback = () => {
      el.connectionDot.classList.remove("connected");
      el.connectionLabel.textContent = "Disconnected";
    };
  } catch (err) {
    console.error(err);
    el.connectionLabel.textContent = "Connection failed";
    alert(`Couldn't connect: ${err.message}`);
  }
});

function onLocalHit(segment) {
  if (!online.active || online.gameOver) return;
  if (online.activeSide !== "me") {
    showNotice("Not your turn yet - wait for the opponent to finish.");
    return;
  }
  peerLink?.sendGameMessage({ type: "dart", segment });
  applyThrow("me", segment);
}

function onLocalEndTurn() {
  // The board's physical button - ends your turn now without waiting for
  // 3 registered darts (e.g. a dart bounced out or missed the board).
  if (!online.active || online.gameOver) return;
  if (online.activeSide !== "me") {
    showNotice("Not your turn yet - wait for the opponent to finish.");
    return;
  }
  peerLink?.sendGameMessage({ type: "end_turn" });
  endTurn("me");
  renderOnline();
}

function onLocalQuickTotal(totalValue) {
  if (!online.active || online.gameOver) return;
  if (online.activeSide !== "me") {
    showNotice("Not your turn yet - wait for the opponent to finish.");
    return;
  }
  peerLink?.sendGameMessage({ type: "quick_total", value: totalValue });
  applyQuickTotalThrow("me", totalValue);
}

// DartConnect-style whole-turn-total entry. Unlike applyThrow, this always
// finalizes the turn immediately regardless of dartsThisTurn count - see
// quickentry.js for the double-out assumption this makes.
function applyQuickTotalThrow(side, totalValue) {
  if (online.gameOver) return;
  // A turn total says nothing about WHICH numbers were hit, so it has no
  // meaning in cricket. The UI hides it there; this guards the message path.
  if (online.gameType === "cricket") return;
  if (online.activeSide !== side) {
    console.warn(`Ignored an out-of-turn '${side}' turn total.`);
    return;
  }

  const s = online[side];
  const segment = {
    value: totalValue,
    type: SegmentType.Double, // exact-0 entries assume a valid finish
    longName: `Turn total: ${totalValue}`,
  };
  // Entered by someone who watched the darts land, so it's taken at face
  // value: it counts as being "in", and an exact zero is assumed legal under
  // whatever the leg's out rule is.
  s.opened = true;
  const { after, isBust, isWin } = resolveThrow(s.remaining, segment, {
    inRule: "straight",
    outRule: "straight",
    opened: true,
  });

  // A whole-turn total has no single board position to point at.
  if (side === "me") hideMarker(el.dartboardMarker);

  online.log.unshift({
    side,
    label: segment.longName,
    remainingAfter: isBust ? s.startOfTurn : Math.max(after, 0),
    bust: isBust,
  });

  if (isBust) {
    s.remaining = s.startOfTurn;
    endTurn(side);
  } else {
    s.remaining = after;
    if (isWin) {
      finishOnlineLeg(side);
    } else {
      endTurn(side);
    }
  }

  renderOnline();
}

function applyThrow(side, segment) {
  if (online.gameOver) return;
  if (online.activeSide !== side) {
    // Out-of-order message (shouldn't normally happen on an ordered
    // DataChannel) - ignore rather than corrupt state.
    console.warn(`Ignored an out-of-turn '${side}' throw.`);
    return;
  }

  if (online.gameType === "cricket") return applyCricketThrowOnline(side, segment);

  const s = online[side];
  const rules = rulesFor(online.legConfig?.rules);
  const { after, isBust, isWin, opened, ignored } = resolveThrow(s.remaining, segment, {
    inRule: rules.in,
    outRule: rules.out,
    opened: s.opened !== false,
  });
  s.opened = opened;

  // The board is this player's own input surface, so the marker tracks THEIR
  // darts only - the opponent's throws still show in the throw log, but
  // putting them on the same board would make it ambiguous whose last dart
  // the marker represents.
  if (side === "me") moveMarkerTo(el.dartboardMarker, segment);

  s.dartsThisTurn.push(segment);
  online.log.unshift({
    side,
    label: ignored ? `${segment.longName} - not in yet` : segment.longName,
    remainingAfter: isBust ? s.startOfTurn : Math.max(after, 0),
    bust: isBust,
  });

  if (isBust) {
    s.remaining = s.startOfTurn;
    endTurn(side);
  } else {
    s.remaining = after;
    if (isWin) {
      finishOnlineLeg(side);
    } else if (s.dartsThisTurn.length >= 3) {
      endTurn(side);
    }
  }

  renderOnline();
}

// Cricket needs both players' marks to decide whether a number still scores,
// so it's handed the pair with the thrower first. That ordering is safe
// because the rule only ever asks "have the OTHERS closed this?".
function applyCricketThrowOnline(side, segment) {
  const mine = side === "me";
  const players = mine ? [online.me, online.opp] : [online.opp, online.me];
  const player = players[0];

  const result = resolveCricketThrow(players, 0, segment);
  applyCricketResult(player, result);

  if (mine) moveMarkerTo(el.dartboardMarker, segment);

  player.dartsThisTurn.push(segment);
  online.log.unshift({
    side,
    label: describeCricketResult(segment, result),
    remainingAfter: player.points,
    bust: false,
  });

  if (checkCricketWin(players, 0)) {
    finishOnlineLeg(side);
  } else if (player.dartsThisTurn.length >= 3) {
    endTurn(side);
  }

  renderOnline();
}

function endTurn(side) {
  const s = online[side];
  s.dartsThisTurn = [];
  // Cricket has no bust, so there's no start-of-turn value to revert to.
  if (online.gameType !== "cricket") s.startOfTurn = s.remaining;
  online.activeSide = side === "me" ? "opp" : "me";
}

// ---------- Render ----------
function renderOnline() {
  const cricket = online.gameType === "cricket";

  // Cricket shows marks; x01 shows a remaining score. Only one at a time.
  el.cricketBoard?.classList.toggle("hidden", !cricket);
  el.manualSection?.classList.toggle("cricket-mode", cricket);

  if (cricket) {
    // "me" first so the local player always reads on the left, whichever
    // side of the match they are.
    renderCricketBoard(el.cricketBoard, [online.me, online.opp],
      online.activeSide === "me" ? 0 : 1);
    el.meScore.textContent = online.me.points;
    el.oppScore.textContent = online.opp.points;
  } else {
    el.meScore.textContent = online.me.remaining;
    el.oppScore.textContent = online.opp.remaining;
  }

  el.meBox.classList.toggle("active-turn", online.activeSide === "me" && !online.gameOver);
  el.oppBox.classList.toggle("active-turn", online.activeSide === "opp" && !online.gameOver);

  renderOnlineMatchBar();

  el.turnLabel.textContent = online.gameOver
    ? (online.iWon ? "You win the leg! 🎯" : "Opponent takes the leg.")
    : online.activeSide === "me" ? "Your turn" : "Opponent's turn";

  el.turnDarts.innerHTML = "";
  const darts = online.activeSide === "me" ? online.me.dartsThisTurn : online.opp.dartsThisTurn;
  for (let i = 0; i < 3; i++) {
    const slot = document.createElement("div");
    slot.className = "dart-slot" + (darts[i] ? " filled" : "");
    slot.textContent = darts[i] ? darts[i].shortName : "-";
    el.turnDarts.appendChild(slot);
  }

  el.throwLog.innerHTML = "";
  online.log.slice(0, 12).forEach((entry) => {
    const row = document.createElement("div");
    row.className = "log-row" + (entry.bust ? " bust" : "");
    row.textContent = `${entry.side === "me" ? "You" : "Opponent"}: ${entry.label} → ${entry.remainingAfter}`;
    el.throwLog.appendChild(row);
  });

  el.winnerBanner.classList.toggle("hidden", !online.gameOver);
  if (online.gameOver) el.winnerBanner.textContent = onlineBannerText();

  // Manual entry stays clickable at all times - a hard CSS block here was
  // indistinguishable from a bug if the visual state ever fell out of sync
  // with the real turn state. Turn enforcement lives in the handlers, which
  // show an on-screen message if you act out of turn.
  const canAct = online.active && !online.gameOver && online.activeSide === "me";
  el.manualSection.style.opacity = canAct ? "1" : "0.7";
}

// Leg progress and the running leg tally. Hidden entirely for a single game,
// so a one-off match looks exactly as it did before medleys existed.
function renderOnlineMatchBar() {
  if (!el.matchBar) return;
  const match = online.match;
  const multiLeg = match && match.legs.length > 1;

  el.matchBar.classList.toggle("hidden", !multiLeg);
  el.nextLegBtn?.classList.toggle("hidden", !online.legOver);
  if (!multiLeg) return;

  // Names are ordered by absolute index (host first), so they're relabelled
  // from each player's own point of view.
  const names = [];
  names[online.myIndex] = "You";
  names[online.oppIndex] = "Opponent";

  el.matchBar.querySelector(".match-progress").textContent = legProgressText(match);
  el.matchBar.querySelector(".match-score").textContent = matchScoreText(match, names);
}

function onlineBannerText() {
  const match = online.match;
  const names = [];
  names[online.myIndex] = "You";
  names[online.oppIndex] = "Opponent";

  if (match?.over) {
    if (match.drawn) return `Match drawn · ${matchScoreText(match, names)}`;
    const iWonMatch = match.winnerIndex === online.myIndex;
    if (match.legs.length > 1) {
      return `${iWonMatch ? "🏆 You win the match" : "Opponent wins the match"} · ${matchScoreText(match, names)}`;
    }
    return iWonMatch ? "🏆 You win!" : "Opponent wins this one.";
  }

  return `${online.iWon ? "You take" : "Opponent takes"} leg ${match.currentLeg + 1} · ${matchScoreText(match, names)}`;
}
