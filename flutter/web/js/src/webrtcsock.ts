import * as message from "./message.js";

// Must match hbb_common/src/webrtc.rs: each data channel message carries a 1-byte header saying
// whether more fragments of the same logical message follow.
const FRAG_MORE = 1;
const FRAG_END = 0;
const MAX_FRAGMENT_PAYLOAD = 60000;

const DEFAULT_ICE_SERVERS = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
  "stun:stun.antisip.com:3478",
  "stun:stun.nextcloud.com:443",
];

const ENDPOINT_PREFIX = "webrtc://";

function encodeEndpoint(desc: object): string {
  return ENDPOINT_PREFIX + btoa(JSON.stringify(desc));
}

function decodeEndpoint(endpoint: string): { type: string; sdp: string } {
  if (!endpoint.startsWith(ENDPOINT_PREFIX)) {
    throw new Error("Invalid WebRTC endpoint format");
  }
  return JSON.parse(atob(endpoint.slice(ENDPOINT_PREFIX.length)));
}

// The value of the first `a=fingerprint:` line, e.g. "sha-256 AB:CD:...", which is what the
// native peer uses as the session key and signs into its identity.
function getFingerprint(sdp: string): string {
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("a=fingerprint:")) {
      return line.slice("a=fingerprint:".length).trim();
    }
  }
  throw new Error("SDP fingerprint attribute not found");
}

export function isWebrtcEnabled(): boolean {
  return localStorage.getItem("option:local:enable-webrtc") != "N";
}

// A peer-to-peer transport to a native peer over a WebRTC data channel, with the same interface
// as Websock. The browser is always the offerer; signaling goes through the rendezvous server.
export default class WebRTCSock {
  _pc: RTCPeerConnection;
  _dc: RTCDataChannel;
  _buf: message.Message[];
  _acc: Uint8Array[];
  _accLen: number;
  _status: any;
  _bytesReceived: number;
  _pendingLocal: string[];
  _onLocalCandidate: ((candidate: string) => void) | undefined;
  sessionKey: string;
  remoteFingerprint: string;

  constructor() {
    this._buf = [];
    this._acc = [];
    this._accLen = 0;
    this._status = "";
    this._bytesReceived = 0;
    this._pendingLocal = [];
    this.sessionKey = "";
    this.remoteFingerprint = "";
    this._pc = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS.map((urls) => ({ urls })),
    });
    this._dc = this._pc.createDataChannel("bootstrap");
    this._dc.binaryType = "arraybuffer";
    this._dc.onopen = () => {
      this._status = "open";
    };
    this._dc.onclose = () => {
      this._status = "closed";
    };
    this._dc.onmessage = (e) => this._recv(e.data);
    this._pc.onicecandidate = (e) => {
      if (!e.candidate?.candidate) return;
      const candidate = JSON.stringify(e.candidate.toJSON());
      if (this._onLocalCandidate) {
        this._onLocalCandidate(candidate);
      } else {
        this._pendingLocal.push(candidate);
      }
    };
  }

  // The offer endpoint for PunchHoleRequest.webrtc_sdp_offer. Candidates are left out and
  // trickled separately, as the native peers do.
  async createOffer(): Promise<string> {
    const offer = await this._pc.createOffer();
    const sdp = offer.sdp || "";
    this.sessionKey = getFingerprint(sdp);
    const trickleSdp = sdp
      .split(/\r?\n/)
      .filter(
        (line) =>
          line &&
          !line.startsWith("a=candidate:") &&
          !line.startsWith("a=end-of-candidates")
      )
      .map((line) => line + "\r\n")
      .join("");
    await this._pc.setLocalDescription(offer);
    // ice_policy "all": the browser gathers every candidate type, so the peer may too.
    return encodeEndpoint({ type: "offer", sdp: trickleSdp, ice_policy: "all" });
  }

  async setAnswer(endpoint: string) {
    const desc = decodeEndpoint(endpoint);
    // The browser checks the DTLS certificate against this fingerprint, so once the channel is
    // open it identifies the peer's certificate.
    this.remoteFingerprint = getFingerprint(desc.sdp);
    await this._pc.setRemoteDescription({ type: "answer", sdp: desc.sdp });
  }

  async addRemoteCandidate(candidate: string) {
    try {
      await this._pc.addIceCandidate(JSON.parse(candidate));
    } catch (e) {
      console.debug("Failed to add remote ICE candidate: ", e);
    }
  }

  onLocalCandidate(callback: (candidate: string) => void) {
    this._onLocalCandidate = callback;
    this._pendingLocal.splice(0).forEach(callback);
  }

  waitOpen(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const tm0 = new Date().getTime();
      const check = () => {
        if (this._status == "open") {
          resolve();
        } else if (
          this._status == "closed" ||
          this._pc.connectionState == "failed" ||
          this._pc.connectionState == "closed"
        ) {
          reject("WebRTC connection failed");
        } else if (new Date().getTime() > tm0 + timeout) {
          reject("WebRTC connect timeout");
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  // Whether the selected candidate pair goes through a TURN server.
  async isRelayed(): Promise<boolean> {
    try {
      const stats: any = await this._pc.getStats();
      let pairId: string | undefined;
      stats.forEach((s: any) => {
        if (s.type == "transport" && s.selectedCandidatePairId) {
          pairId = s.selectedCandidatePairId;
        }
      });
      if (!pairId) {
        stats.forEach((s: any) => {
          if (s.type == "candidate-pair" && s.nominated && s.state == "succeeded") {
            pairId = s.id;
          }
        });
      }
      const pair: any = pairId && stats.get(pairId);
      if (!pair) return false;
      return [pair.localCandidateId, pair.remoteCandidateId].some(
        (id) => stats.get(id)?.candidateType == "relay"
      );
    } catch (e) {
      return false;
    }
  }

  takeBytesReceived(): number {
    const n = this._bytesReceived;
    this._bytesReceived = 0;
    return n;
  }

  // DTLS encrypts the channel; the peer applies no stream key on WebRTC.
  setSecretKey(_: Uint8Array) {}

  sendMessage(json: message.DeepPartial<message.Message>) {
    if (this._dc.readyState != "open") return;
    const data = message.Message.encode(message.Message.fromPartial(json)).finish();
    let offset = 0;
    do {
      const end = Math.min(offset + MAX_FRAGMENT_PAYLOAD, data.length);
      const frag = new Uint8Array(1 + end - offset);
      frag[0] = end >= data.length ? FRAG_END : FRAG_MORE;
      frag.set(data.subarray(offset, end), 1);
      this._dc.send(frag);
      offset = end;
    } while (offset < data.length);
  }

  async next(timeout = 12000): Promise<message.Message> {
    const func = (
      resolve: (value: message.Message) => void,
      reject: (reason: any) => void,
      tm0: number
    ) => {
      if (this._buf.length) {
        resolve(this._buf[0]);
        this._buf.splice(0, 1);
      } else if (this._status != "open") {
        reject(this._status || "Reset by the peer");
      } else if (new Date().getTime() > tm0 + timeout) {
        reject("Timeout");
      } else {
        setTimeout(() => func(resolve, reject, tm0), 1);
      }
    };
    return new Promise((resolve, reject) => {
      func(resolve, reject, new Date().getTime());
    });
  }

  close() {
    this._status = "closed";
    this._dc.onmessage = null;
    this._pc.onicecandidate = null;
    this._pc.close();
  }

  _recv(data: any) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;
    this._bytesReceived += data.byteLength;
    const bytes = new Uint8Array(data);
    const header = bytes[0];
    const payload = bytes.subarray(1);
    if (header != FRAG_END && header != FRAG_MORE) {
      console.error("WebRTC fragment header " + header + " is invalid");
      this.close();
      return;
    }
    if (header == FRAG_END && !this._acc.length) {
      this._buf.push(message.Message.decode(payload));
      return;
    }
    this._acc.push(payload);
    this._accLen += payload.length;
    if (header == FRAG_END) {
      const whole = new Uint8Array(this._accLen);
      let offset = 0;
      for (const part of this._acc) {
        whole.set(part, offset);
        offset += part.length;
      }
      this._acc = [];
      this._accLen = 0;
      this._buf.push(message.Message.decode(whole));
    }
  }
}
