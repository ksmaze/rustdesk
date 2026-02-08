import Websock from "./websock";
import * as message from "./message.js";
import * as rendezvous from "./rendezvous.js";
import { loadVp9 } from "./codec";
import * as sha256 from "fast-sha256";
import * as globals from "./globals";
import * as consts from "./consts";
import { decompress, mapKey, sleep } from "./common";

export const PORT = 21116;
const HOSTS = [
  "rs-sg.rustdesk.com",
  "rs-cn.rustdesk.com",
  "rs-us.rustdesk.com",
];
let HOST = localStorage.getItem("rendezvous-server") || HOSTS[0];
const SCHEMA = "ws://";

type MsgboxCallback = (type: string, title: string, text: string, link: string) => void;
type DrawCallback = (display: number, data: Uint8Array) => void;
//const cursorCanvas = document.createElement("canvas");

// USB HID usage code -> internal key name (from production rustdesk web client)
const USB_HID_MAP: Record<number, string> = {
  226:"Alt",230:"AltGr",42:"Backspace",57:"CapsLock",224:"ControlLeft",228:"ControlRight",
  76:"Delete",82:"UpArrow",81:"DownArrow",80:"LeftArrow",79:"RightArrow",77:"End",41:"Escape",
  58:"F1",59:"F2",60:"F3",61:"F4",62:"F5",63:"F6",64:"F7",65:"F8",66:"F9",67:"F10",68:"F11",69:"F12",
  104:"F13",105:"F14",106:"F15",107:"F16",108:"F17",109:"F18",110:"F19",111:"F20",
  112:"F21",113:"F22",114:"F23",115:"F24",
  74:"Home",227:"MetaLeft",78:"PageDown",75:"PageUp",40:"Return",225:"ShiftLeft",229:"ShiftRight",
  44:"Space",43:"Tab",70:"PrintScreen",71:"ScrollLock",83:"NumLock",
  53:"BackQuote",30:"Num1",31:"Num2",32:"Num3",33:"Num4",34:"Num5",35:"Num6",36:"Num7",37:"Num8",38:"Num9",39:"Num0",
  45:"Minus",46:"Equal",
  20:"KeyQ",26:"KeyW",8:"KeyE",21:"KeyR",23:"KeyT",28:"KeyY",24:"KeyU",12:"KeyI",18:"KeyO",19:"KeyP",
  47:"LeftBracket",48:"RightBracket",49:"BackSlash",
  4:"KeyA",22:"KeyS",7:"KeyD",9:"KeyF",10:"KeyG",11:"KeyH",13:"KeyJ",14:"KeyK",15:"KeyL",
  51:"SemiColon",52:"Quote",
  100:"IntlBackslash",135:"IntlRo",137:"IntlYen",
  29:"KeyZ",27:"KeyX",6:"KeyC",25:"KeyV",5:"KeyB",17:"KeyN",16:"KeyM",
  54:"Comma",55:"Dot",56:"Slash",73:"Insert",
  86:"KpMinus",87:"KpPlus",85:"KpMultiply",84:"KpDivide",99:"KpDecimal",88:"KpReturn",103:"KpEqual",133:"KpComma",
  98:"Kp0",89:"Kp1",90:"Kp2",91:"Kp3",92:"Kp4",93:"Kp5",94:"Kp6",95:"Kp7",96:"Kp8",97:"Kp9",
  231:"MetaRight",128:"VolumeUp",129:"VolumeDown",127:"VolumeMute",
  139:"Lang1",138:"Lang2",146:"Lang3",147:"Lang4",148:"Lang5",
  155:"Cancel",156:"Clear",136:"Kana",145:"Hanja",119:"Select",116:"Execute",117:"Help",159:"Separator"
};

// Windows scancode map: key name -> scancode
const WIN_SCANCODE_MAP: Record<string, number> = {
  Alt:56,AltGr:57400,Backspace:14,CapsLock:58,ControlLeft:29,ControlRight:57373,
  Delete:57427,UpArrow:57416,DownArrow:57424,LeftArrow:57419,RightArrow:57421,
  End:57423,Escape:1,F1:59,F2:60,F3:61,F4:62,F5:63,F6:64,F7:65,F8:66,F9:67,F10:68,F11:87,F12:88,
  F13:100,F14:101,F15:102,F16:103,F17:104,F18:105,F19:106,F20:107,F21:108,F22:109,F23:110,F24:118,
  Home:57415,MetaLeft:57435,PageDown:57425,PageUp:57417,Return:28,ShiftLeft:42,ShiftRight:54,
  Space:57,Tab:15,PrintScreen:57399,ScrollLock:70,NumLock:69,
  BackQuote:41,Num1:2,Num2:3,Num3:4,Num4:5,Num5:6,Num6:7,Num7:8,Num8:9,Num9:10,Num0:11,
  Minus:12,Equal:13,
  KeyQ:16,KeyW:17,KeyE:18,KeyR:19,KeyT:20,KeyY:21,KeyU:22,KeyI:23,KeyO:24,KeyP:25,
  LeftBracket:26,RightBracket:27,BackSlash:43,
  KeyA:30,KeyS:31,KeyD:32,KeyF:33,KeyG:34,KeyH:35,KeyJ:36,KeyK:37,KeyL:38,
  SemiColon:39,Quote:40,IntlBackslash:86,IntlRo:115,IntlYen:125,KanaMode:112,
  KeyZ:44,KeyX:45,KeyC:46,KeyV:47,KeyB:48,KeyN:49,KeyM:50,Comma:51,Dot:52,Slash:53,
  Insert:57426,
  KpMinus:74,KpPlus:78,KpMultiply:55,KpDivide:57397,KpDecimal:83,KpReturn:57372,KpEqual:89,KpComma:126,
  Kp0:82,Kp1:79,Kp2:80,Kp3:81,Kp4:75,Kp5:76,Kp6:77,Kp7:71,Kp8:72,Kp9:73,
  MetaRight:57436,Apps:57437,VolumeUp:57392,VolumeDown:57390,VolumeMute:57376,
  Lang1:123,Lang2:121,Lang3:120,Lang4:119,Lang5:118,Kana:128,Hanja:241
};

// Linux keycode map: key name -> keycode
const LINUX_SCANCODE_MAP: Record<string, number> = {
  Alt:64,AltGr:108,Backspace:22,CapsLock:66,ControlLeft:37,ControlRight:105,
  Delete:119,DownArrow:116,End:115,Escape:9,
  F1:67,F10:76,F11:95,F12:96,F13:191,F14:192,F15:193,F16:194,F17:195,F18:196,F19:197,F20:198,
  F21:199,F22:200,F23:201,F24:202,F2:68,F3:69,F4:70,F5:71,F6:72,F7:73,F8:74,F9:75,
  Home:110,LeftArrow:113,MetaLeft:133,PageDown:117,PageUp:112,Return:36,RightArrow:114,
  ShiftLeft:50,ShiftRight:62,Space:65,Tab:23,UpArrow:111,PrintScreen:107,ScrollLock:78,Pause:127,NumLock:77,
  BackQuote:49,Num1:10,Num2:11,Num3:12,Num4:13,Num5:14,Num6:15,Num7:16,Num8:17,Num9:18,Num0:19,
  Minus:20,Equal:21,
  KeyQ:24,KeyW:25,KeyE:26,KeyR:27,KeyT:28,KeyY:29,KeyU:30,KeyI:31,KeyO:32,KeyP:33,
  LeftBracket:34,RightBracket:35,
  KeyA:38,KeyS:39,KeyD:40,KeyF:41,KeyG:42,KeyH:43,KeyJ:44,KeyK:45,KeyL:46,
  SemiColon:47,Quote:48,BackSlash:51,IntlBackslash:94,IntlRo:97,IntlYen:132,KanaMode:101,
  KeyZ:52,KeyX:53,KeyC:54,KeyV:55,KeyB:56,KeyN:57,KeyM:58,Comma:59,Dot:60,Slash:61,
  Insert:118,
  KpDecimal:91,KpReturn:104,KpMinus:82,KpPlus:86,KpMultiply:63,KpDivide:106,KpEqual:125,KpComma:129,
  Kp0:90,Kp1:87,Kp2:88,Kp3:89,Kp4:83,Kp5:84,Kp6:85,Kp7:79,Kp8:80,Kp9:81,
  MetaRight:134,Apps:135,VolumeUp:123,VolumeDown:122,VolumeMute:121,
  Lang1:102,Lang2:100,Lang3:98,Lang4:99,Lang5:93
};

// macOS keycode map: key name -> keycode
const MACOS_SCANCODE_MAP: Record<string, number> = {
  KeyA:0,KeyS:1,KeyD:2,KeyF:3,KeyH:4,KeyG:5,KeyZ:6,KeyX:7,KeyC:8,KeyV:9,IntlBackslash:10,
  KeyB:11,KeyQ:12,KeyW:13,KeyE:14,KeyR:15,KeyY:16,KeyT:17,
  Num1:18,Num2:19,Num3:20,Num4:21,Num6:22,Num5:23,Equal:24,Num9:25,Num7:26,Minus:27,Num8:28,Num0:29,
  RightBracket:30,KeyO:31,KeyU:32,LeftBracket:33,KeyI:34,KeyP:35,Return:36,KeyL:37,KeyJ:38,
  Quote:39,KeyK:40,SemiColon:41,BackSlash:42,Comma:43,Slash:44,KeyN:45,KeyM:46,Dot:47,
  Tab:48,Space:49,BackQuote:50,Backspace:51,Escape:53,MetaRight:54,MetaLeft:55,
  ShiftLeft:56,CapsLock:57,Alt:58,ControlLeft:59,ShiftRight:60,AltGr:61,ControlRight:62,
  F17:64,KpDecimal:65,KpMultiply:67,KpPlus:69,NumLock:71,
  VolumeUp:72,VolumeDown:73,VolumeMute:74,KpDivide:75,KpReturn:76,KpMinus:78,
  F18:79,F19:80,KpEqual:81,
  Kp0:82,Kp1:83,Kp2:84,Kp3:85,Kp4:86,Kp5:87,Kp6:88,Kp7:89,F20:90,Kp8:91,Kp9:92,
  IntlYen:93,IntlRo:94,KpComma:95,
  F5:96,F6:97,F7:98,F3:99,F8:100,F9:101,Lang2:102,F11:103,Lang1:104,F13:105,F16:106,F14:107,
  F10:109,F12:111,F15:113,Insert:114,Home:115,PageUp:116,Delete:117,F4:118,End:119,F2:120,
  PageDown:121,F1:122,LeftArrow:123,RightArrow:124,DownArrow:125,UpArrow:126,Apps:110
};

// Android keycode map: key name -> keycode
const ANDROID_SCANCODE_MAP: Record<string, number> = {
  Alt:57,AltGr:58,Backspace:67,CapsLock:115,ControlLeft:113,ControlRight:114,
  Delete:112,DownArrow:20,End:123,Escape:111,
  F1:131,F10:140,F11:141,F12:142,F2:132,F3:133,F4:134,F5:135,F6:136,F7:137,F8:138,F9:139,
  Home:3,LeftArrow:21,MetaLeft:117,PageDown:93,PageUp:92,Return:66,RightArrow:22,
  ShiftLeft:59,ShiftRight:60,Space:62,Tab:61,UpArrow:19,PrintScreen:120,ScrollLock:116,NumLock:143,Pause:121,
  BackQuote:75,Num1:8,Num2:9,Num3:10,Num4:11,Num5:12,Num6:13,Num7:14,Num8:15,Num9:16,Num0:7,
  Minus:69,Equal:70,
  KeyA:29,KeyB:30,KeyC:31,KeyD:32,KeyE:33,KeyF:34,KeyG:35,KeyH:36,KeyI:37,KeyJ:38,KeyK:39,KeyL:40,
  KeyM:41,KeyN:42,KeyO:43,KeyP:44,KeyQ:45,KeyR:46,KeyS:47,KeyT:48,KeyU:49,KeyV:50,KeyW:51,KeyX:52,KeyY:53,KeyZ:54,
  LeftBracket:71,RightBracket:72,SemiColon:74,Quote:75,BackSlash:73,KanaMode:218,
  Comma:55,Dot:56,Slash:76,Insert:124
};

// Character keys that may be affected by CapsLock
const CHAR_KEYS = new Set([
  "BackQuote","Num1","Num2","Num3","Num4","Num5","Num6","Num7","Num8","Num9","Num0",
  "Minus","Equal",
  "KeyA","KeyB","KeyC","KeyD","KeyE","KeyF","KeyG","KeyH","KeyI","KeyJ","KeyK","KeyL","KeyM",
  "KeyN","KeyO","KeyP","KeyQ","KeyR","KeyS","KeyT","KeyU","KeyV","KeyW","KeyX","KeyY","KeyZ",
  "LeftBracket","RightBracket","BackSlash","SemiColon","Quote","Comma","Dot","Slash",
  "IntlBackslash","Space"
]);

// Numpad keys that may be affected by NumLock
const NUMPAD_KEYS = new Set([
  "Kp0","Kp1","Kp2","Kp3","Kp4","Kp5","Kp6","Kp7","Kp8","Kp9",
  "KpMinus","KpMultiply","KpDivide","KpPlus","KpDecimal"
]);

function applyLockModes(events: message.KeyEvent[], lockModes: number, isNumpad: boolean, isChar: boolean) {
  for (const ev of events) {
    if (isChar && (lockModes & (1 << 1)) !== 0) {
      ev.modifiers.push(message.ControlKey.CapsLock);
    }
    if (isNumpad && (lockModes & (1 << 2)) !== 0) {
      ev.modifiers.push(message.ControlKey.NumLock);
    }
  }
}

export default class Connection {
  _msgs: any[];
  _ws: Websock | undefined;
  _interval: any;
  _id: string;
  _hash: message.Hash | undefined;
  _msgbox: MsgboxCallback;
  _draw: DrawCallback;
  _peerInfo: message.PeerInfo | undefined;
  _firstFrame: Boolean | undefined;
  _videoDecoder: any;
  _password: Uint8Array | undefined;
  _options: any;
  _videoTestSpeed: number[];
  //_cursors: { [name: number]: any };

  constructor() {
    this._msgbox = globals.msgbox;
    this._draw = globals.draw;
    this._msgs = [];
    this._id = "";
    this._videoTestSpeed = [0, 0];
    //this._cursors = {};
  }

  async start(id: string) {
    try {
      await this._start(id);
    } catch (e: any) {
      this.msgbox(
        "error",
        "Connection Error",
        e.type == "close" ? "Reset by the peer" : String(e)
      );
    }
  }

  async _start(id: string) {
    if (!this._options) {
      this._options = globals.getPeers()[id] || {};
    }
    if (!this._password) {
      const p = this.getOption("password");
      if (p) {
        try {
          this._password = Uint8Array.from(JSON.parse("[" + p + "]"));
        } catch (e) {
          console.error('Failed to get password, ' + e);
        }
      }
    }
    this._interval = setInterval(() => {
      while (this._msgs.length) {
        this._ws?.sendMessage(this._msgs[0]);
        this._msgs.splice(0, 1);
      }
    }, 1);
    this.loadVideoDecoder();
    const uri = getDefaultUri();
    const ws = new Websock(uri, true);
    this._ws = ws;
    this._id = id;
    console.log(
      new Date() + ": Connecting to rendezvous server: " + uri + ", for " + id
    );
    await ws.open();
    console.log(new Date() + ": Connected to rendezvous server");
    const conn_type = rendezvous.ConnType.DEFAULT_CONN;
    const nat_type = rendezvous.NatType.SYMMETRIC;
    const punch_hole_request = rendezvous.PunchHoleRequest.fromPartial({
      id,
      licence_key: localStorage.getItem("key") || undefined,
      conn_type,
      nat_type,
      token: localStorage.getItem("access_token") || undefined,
    });
    ws.sendRendezvous({ punch_hole_request });
    const msg = (await ws.next()) as rendezvous.RendezvousMessage;
    ws.close();
    console.log(new Date() + ": Got relay response");
    const phr = msg.punch_hole_response;
    const rr = msg.relay_response;
    if (phr) {
      if (phr?.other_failure) {
        this.msgbox("error", "Error", phr?.other_failure);
        return;
      }
      if (phr.failure != rendezvous.PunchHoleResponse_Failure.UNRECOGNIZED) {
        switch (phr?.failure) {
          case rendezvous.PunchHoleResponse_Failure.ID_NOT_EXIST:
            this.msgbox("error", "Error", "ID does not exist");
            break;
          case rendezvous.PunchHoleResponse_Failure.OFFLINE:
            this.msgbox("error", "Error", "Remote desktop is offline");
            break;
          case rendezvous.PunchHoleResponse_Failure.LICENSE_MISMATCH:
            this.msgbox("error", "Error", "Key mismatch");
            break;
          case rendezvous.PunchHoleResponse_Failure.LICENSE_OVERUSE:
            this.msgbox("error", "Error", "Key overuse");
            break;
        }
      }
    } else if (rr) {
      if (!rr.version) {
        this.msgbox("error", "Error", "Remote version is low, not support web");
        return;
      }
      await this.connectRelay(rr);
    }
  }

  async connectRelay(rr: rendezvous.RelayResponse) {
    const pk = rr.pk;
    let uri = rr.relay_server;
    if (uri) {
      uri = getrUriFromRs(uri, true, 2);
    } else {
      uri = getDefaultUri(true);
    }
    const uuid = rr.uuid;
    console.log(new Date() + ": Connecting to relay server: " + uri);
    const ws = new Websock(uri, false);
    await ws.open();
    console.log(new Date() + ": Connected to relay server");
    this._ws = ws;
    const request_relay = rendezvous.RequestRelay.fromPartial({
      licence_key: localStorage.getItem("key") || undefined,
      uuid,
    });
    ws.sendRendezvous({ request_relay });
    const secure = (await this.secure(pk)) || false;
    globals.pushEvent("connection_ready", { secure, direct: false });
    await this.msgLoop();
  }

  async secure(pk: Uint8Array | undefined) {
    if (pk) {
      const RS_PK = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=";
      try {
        pk = await globals.verify(pk, localStorage.getItem("key") || RS_PK);
        if (pk) {
          const idpk = message.IdPk.decode(pk);
          if (idpk.id == this._id) {
            pk = idpk.pk;
          }
        }
        if (pk?.length != 32) {
          pk = undefined;
        }
      } catch (e) {
        console.error('Failed to verify id pk, ', e);
        pk = undefined;
      }
      if (!pk)
        console.error(
          "Handshake failed: invalid public key from rendezvous server"
        );
    }
    if (!pk) {
      // send an empty message out in case server is setting up secure and waiting for first message
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    const msg = (await this._ws?.next()) as message.Message;
    let signedId: any = msg?.signed_id;
    if (!signedId) {
      console.error("Handshake failed: invalid message type");
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    try {
      signedId = await globals.verify(signedId.id, Uint8Array.from(pk!));
    } catch (e) {
      console.error('Failed to verify signed id pk, ', e);
      // fall back to non-secure connection in case pk mismatch
      console.error("pk mismatch, fall back to non-secure");
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    const idpk = message.IdPk.decode(signedId);
    const id = idpk.id;
    const theirPk = idpk.pk;
    if (id != this._id!) {
      console.error("Handshake failed: sign failure");
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    if (theirPk.length != 32) {
      console.error(
        "Handshake failed: invalid public box key length from peer"
      );
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    const [mySk, asymmetric_value] = globals.genBoxKeyPair();
    const secret_key = globals.genSecretKey();
    const symmetric_value = globals.seal(secret_key, theirPk, mySk);
    const public_key = message.PublicKey.fromPartial({
      asymmetric_value,
      symmetric_value,
    });
    this._ws?.sendMessage({ public_key });
    this._ws?.setSecretKey(secret_key);
    console.log("secured");
    return true;
  }

  async msgLoop() {
    while (true) {
      const msg = (await this._ws?.next()) as message.Message;
      if (msg?.hash) {
        this._hash = msg?.hash;
        if (!this._password)
          this.msgbox("input-password", "Password Required", "");
        this.login();
      } else if (msg?.test_delay) {
        const test_delay = msg?.test_delay;
        console.log('test delay: ', test_delay);
        if (!test_delay.from_client) {
          this._ws?.sendMessage({ test_delay });
        }
      } else if (msg?.login_response) {
        this.handleLoginResponse(msg?.login_response);
      } else if (msg?.video_frame) {
        this.handleVideoFrame(msg?.video_frame!);
      } else if (msg?.clipboard) {
        const cb = msg?.clipboard;
        if (cb.compress) {
          const c = await decompress(cb.content);
          if (!c) continue;
          cb.content = c;
        }
        try {
          globals.copyToClipboard(new TextDecoder().decode(cb.content));
        } catch (e) {
          console.error('Failed to copy to clipboard, ', e);
        }
        // globals.pushEvent("clipboard", cb);
      } else if (msg?.cursor_data) {
        const cd = msg?.cursor_data;
        const c = await decompress(cd.colors);
        if (!c) continue;
        cd.colors = c;
        globals.pushEvent("cursor_data", cd);
        /*
        let ctx = cursorCanvas.getContext("2d");
        cursorCanvas.width = cd.width;
        cursorCanvas.height = cd.height;
        let imgData = new ImageData(
          new Uint8ClampedArray(c),
          cd.width,
          cd.height
        );
        ctx?.clearRect(0, 0, cd.width, cd.height);
        ctx?.putImageData(imgData, 0, 0);
        let url = cursorCanvas.toDataURL();
        const img = document.createElement("img");
        img.src = url;
        this._cursors[cd.id] = img;
        //cursorCanvas.width /= 2.;
        //cursorCanvas.height /= 2.;
        //ctx?.drawImage(img, cursorCanvas.width, cursorCanvas.height);
        url = cursorCanvas.toDataURL();
        document.body.style.cursor =
          "url(" + url + ")" + cd.hotx + " " + cd.hoty + ", default";
        console.log(document.body.style.cursor);
        */
      } else if (msg?.cursor_id) {
        globals.pushEvent("cursor_id", { id: msg?.cursor_id });
      } else if (msg?.cursor_position) {
        globals.pushEvent("cursor_position", msg?.cursor_position);
      } else if (msg?.misc) {
        if (!this.handleMisc(msg?.misc)) break;
      } else if (msg?.audio_frame) {
        globals.playAudio(msg?.audio_frame.data);
      }
    }
  }

  handleLoginResponse(response: message.LoginResponse) {
    const loginErrorMap: Record<string, any> = {
      [consts.LOGIN_SCREEN_WAYLAND]: {
        msgtype: "error",
        title: "Login Error",
        text: "Login screen using Wayland is not supported",
        link: "https://rustdesk.com/docs/en/manual/linux/#login-screen",
        try_again: true,
      },
      [consts.LOGIN_MSG_DESKTOP_SESSION_NOT_READY]: {
        msgtype: "session-login",
        title: "",
        text: "",
        link: "",
        try_again: true,
      },
      [consts.LOGIN_MSG_DESKTOP_XSESSION_FAILED]: {
        msgtype: "session-re-login",
        title: "",
        text: "",
        link: "",
        try_again: true,
      },
      [consts.LOGIN_MSG_DESKTOP_SESSION_ANOTHER_USER]: {
        msgtype: "info-nocancel",
        title: "another_user_login_title_tip",
        text: "another_user_login_text_tip",
        link: "",
        try_again: false,
      },
      [consts.LOGIN_MSG_DESKTOP_XORG_NOT_FOUND]: {
        msgtype: "info-nocancel",
        title: "xorg_not_found_title_tip",
        text: "xorg_not_found_text_tip",
        link: "https://rustdesk.com/docs/en/manual/linux/#login-screen",
        try_again: true,
      },
      [consts.LOGIN_MSG_DESKTOP_NO_DESKTOP]: {
        msgtype: "info-nocancel",
        title: "no_desktop_title_tip",
        text: "no_desktop_text_tip",
        link: "https://rustdesk.com/docs/en/manual/linux/#login-screen",
        try_again: true,
      },
      [consts.LOGIN_MSG_DESKTOP_SESSION_NOT_READY_PASSWORD_EMPTY]: {
        msgtype: "session-login-password",
        title: "",
        text: "",
        link: "",
        try_again: true,
      },
      [consts.LOGIN_MSG_DESKTOP_SESSION_NOT_READY_PASSWORD_WRONG]: {
        msgtype: "session-login-re-password",
        title: "",
        text: "",
        link: "",
        try_again: true,
      },
      [consts.LOGIN_MSG_NO_PASSWORD_ACCESS]: {
        msgtype: "wait-remote-accept-nook",
        title: "Prompt",
        text: "Please wait for the remote side to accept your session request...",
        link: "",
        try_again: true,
      },
    };

    const err = response.error;
    if (err) {
      if (err == consts.LOGIN_MSG_PASSWORD_EMPTY) {
        this._password = undefined;
        this.msgbox("input-password", "Password Required", "", "");
      }
      if (err == consts.LOGIN_MSG_PASSWORD_WRONG) {
        this._password = undefined;
        this.msgbox(
          "re-input-password",
          err,
          "Do you want to enter again?"
        );
      } else if (err == consts.LOGIN_MSG_2FA_WRONG || err == consts.REQUIRE_2FA) {
        this.msgbox("input-2fa", err, "");
      } else if (err in loginErrorMap) {
        const m = loginErrorMap[err];
        this.msgbox(m.msgtype, m.title, m.text, m.link);
      } else {
        if (err.includes(consts.SCRAP_X11_REQUIRED)) {
          this.msgbox("error", "Login Error", err, consts.SCRAP_X11_REF_URL);
        } else {
          this.msgbox("error", "Login Error", err);
        }
      }
    } else if (response.peer_info) {
      this.handlePeerInfo(response.peer_info);
    }
  }

  msgbox(type_: string, title: string, text: string, link: string = '') {
    this._msgbox?.(type_, title, text, link);
  }

  draw(display: number, frame: any) {
    this._draw?.(display, frame);
    globals.draw(display, frame);
  }

  close() {
    this._msgs = [];
    clearInterval(this._interval);
    this._ws?.close();
    this._videoDecoder?.close();
  }

  refresh() {
    const misc = message.Misc.fromPartial({ refresh_video: true });
    this._ws?.sendMessage({ misc });
  }

  setMsgbox(callback: MsgboxCallback) {
    this._msgbox = callback;
  }

  setDraw(callback: DrawCallback) {
    this._draw = callback;
  }

  login(info?: {
    os_login?: message.OSLogin,
    password?: Uint8Array
  }) {
    if (info?.password) {
      const salt = this._hash?.salt;
      let p = hash([info.password, salt!]);
      this._password = p;
      const challenge = this._hash?.challenge;
      p = hash([p, challenge!]);
      this.msgbox("connecting", "Connecting...", "Logging in...");
      this._sendLoginMessage({ os_login: info.os_login, password: p });
    } else {
      let p = this._password;
      if (p) {
        const challenge = this._hash?.challenge;
        p = hash([p, challenge!]);
      }
      this._sendLoginMessage({ os_login: info?.os_login, password: p });
    }
  }

  changePreferCodec() {
    const supported_decoding = message.SupportedDecoding.fromPartial({
      ability_vp9: 1,
      ability_h264: 1,
    });
    const option = message.OptionMessage.fromPartial({ supported_decoding });
    const misc = message.Misc.fromPartial({ option });
    this._ws?.sendMessage({ misc });
  }

  async reconnect() {
    this.close();
    await this.start(this._id);
  }

  _sendLoginMessage(login: {
    os_login?: message.OSLogin,
    password?: Uint8Array,
  }) {
    const login_request = message.LoginRequest.fromPartial({
      username: this._id!,
      my_id: "web", // to-do
      my_name: "web", // to-do
      password: login.password,
      option: this.getOptionMessage(),
      video_ack_required: true,
      os_login: login.os_login,
    });
    this._ws?.sendMessage({ login_request });
  }

  getOptionMessage(): message.OptionMessage | undefined {
    let n = 0;
    const msg = message.OptionMessage.fromPartial({});
    const q = this.getImageQualityEnum(this.getImageQuality(), true);
    const yes = message.OptionMessage_BoolOption.Yes;
    if (q != undefined) {
      msg.image_quality = q;
      n += 1;
    }
    if (this._options["show-remote-cursor"]) {
      msg.show_remote_cursor = yes;
      n += 1;
    }
    if (this._options["lock-after-session-end"]) {
      msg.lock_after_session_end = yes;
      n += 1;
    }
    if (this._options["privacy-mode"]) {
      msg.privacy_mode = yes;
      n += 1;
    }
    if (this._options["disable-audio"]) {
      msg.disable_audio = yes;
      n += 1;
    }
    if (this._options["disable-clipboard"]) {
      msg.disable_clipboard = yes;
      n += 1;
    }
    return n > 0 ? msg : undefined;
  }

  sendVideoReceived() {
    const misc = message.Misc.fromPartial({ video_received: true });
    this._ws?.sendMessage({ misc });
  }

  handleVideoFrame(vf: message.VideoFrame) {
    if (!this._firstFrame) {
      this.msgbox("", "", "");
      this._firstFrame = true;
    }
    if (vf.vp9s) {
      const dec = this._videoDecoder;
      var tm = new Date().getTime();
      var i = 0;
      const n = vf.vp9s?.frames.length;
      vf.vp9s.frames.forEach((f) => {
        dec.processFrame(f.data.slice(0).buffer, (ok: any) => {
          i++;
          if (i == n) this.sendVideoReceived();
          if (ok && dec.frameBuffer && n == i) {
            this.draw(vf.display, dec.frameBuffer);
            const now = new Date().getTime();
            var elapsed = now - tm;
            this._videoTestSpeed[1] += elapsed;
            this._videoTestSpeed[0] += 1;
            if (this._videoTestSpeed[0] >= 30) {
              console.log(
                "video decoder: " +
                parseInt(
                  "" + this._videoTestSpeed[1] / this._videoTestSpeed[0]
                )
              );
              this._videoTestSpeed = [0, 0];
            }
          }
        });
      });
    }
  }

  handlePeerInfo(pi: message.PeerInfo) {
    localStorage.setItem('last_remote_id', this._id);
    this._peerInfo = pi;
    if (pi.current_display > pi.displays.length) {
      pi.current_display = 0;
    }
    if (globals.getVersionNumber(pi.version) < globals.getVersionNumber("1.1.10")) {
      this.setPermission("restart", false);
    }
    if (pi.displays.length == 0) {
      this.setOption("info", pi);
      globals.pushEvent("update_privacy_mode", {});
      this.msgbox("error", "Remote Error", "No Display");
      return;
    }
    this.msgbox("success", "Successful", "Connected, waiting for image...");
    globals.pushEvent("peer_info", pi);
    const p = this.shouldAutoLogin();
    if (p) this.inputOsPassword(p);
    const username = this.getOption("info")?.username;
    if (username && !pi.username) pi.username = username;
    globals.pushEvent("update_privacy_mode", {});
    this.setOption("info", pi);
    if (this.getRemember()) {
      if (this._password?.length) {
        const p = this._password.toString();
        if (p != this.getOption("password")) {
          this.setOption("password", p);
          console.log("remember password of " + this._id);
        }
      }
    } else {
      this.setOption("password", undefined);
    }
  }

  setPermission(name: string, value: Boolean) {
    globals.pushEvent("permission", { [name]: value });
  }

  shouldAutoLogin(): string {
    const l = this.getOption("lock-after-session-end");
    const a = !!this.getOption("auto-login");
    const p = this.getOption("os-password");
    if (p && l && a) {
      return p;
    }
    return "";
  }

  handleMisc(misc: message.Misc) {
    if (misc.audio_format) {
      globals.initAudio(
        misc.audio_format.channels,
        misc.audio_format.sample_rate
      );
    } else if (misc.chat_message) {
      globals.pushEvent("chat", { text: misc.chat_message.text });
    } else if (misc.permission_info) {
      const p = misc.permission_info;
      console.info("Change permission " + p.permission + " -> " + p.enabled);
      let name;
      switch (p.permission) {
        case message.PermissionInfo_Permission.Keyboard:
          name = "keyboard";
          break;
        case message.PermissionInfo_Permission.Clipboard:
          name = "clipboard";
          break;
        case message.PermissionInfo_Permission.Audio:
          name = "audio";
          break;
        default:
          return;
      }
      this.setPermission(name, p.enabled);
    } else if (misc.switch_display) {
      this.loadVideoDecoder();
      globals.pushEvent("switch_display", misc.switch_display);
    } else if (misc.close_reason) {
      this.msgbox("error", "Connection Error", misc.close_reason);
      this.close();
      return false;
    }
    return true;
  }

  getRemember(): Boolean {
    return this._options["remember"] || false;
  }

  setRemember(v: Boolean) {
    this.setOption("remember", v);
  }

  getOption(name: string): any {
    return this._options[name] ?? globals.getUserDefaultOption(name);
  }

  getToggleOption(name: string): Boolean {
    // TODO: more default settings
    const defaultToggleTrue = [
      'show-remote-cursor',
      'privacy-mode',
      'enable-file-copy-paste',
      'allow_swap_key',
    ];
    return this._options[name] || (defaultToggleTrue.includes(name) ? true : false);
  }

  // TODO:
  getStatus(): String {
    return JSON.stringify({ status_num: 10 });
  }

  // TODO:
  checkConnStatus() {
  }

  setOption(name: string, value: any) {
    if (value == undefined) {
      delete this._options[name];
    } else {
      this._options[name] = value;
    }
    this._options["tm"] = new Date().getTime();
    const peers = globals.getPeers();
    peers[this._id] = this._options;
    localStorage.setItem("peers", JSON.stringify(peers));
  }

  inputKey(
    name: string,
    down: boolean,
    press: boolean,
    alt: Boolean,
    ctrl: Boolean,
    shift: Boolean,
    command: Boolean
  ) {
    const key_event = mapKey(name, globals.isDesktop());
    if (!key_event) return;
    if (alt && (name == "VK_MENU" || name == "RAlt")) {
      alt = false;
    }
    if (ctrl && (name == "VK_CONTROL" || name == "RControl")) {
      ctrl = false;
    }
    if (shift && (name == "VK_SHIFT" || name == "RShift")) {
      shift = false;
    }
    if (command && (name == "Meta" || name == "RWin")) {
      command = false;
    }
    key_event.down = down;
    key_event.press = press;
    key_event.modifiers = this.getMod(alt, ctrl, shift, command);
    this._ws?.sendMessage({ key_event });
  }

  inputFlutterKey(usbHid: number, down: boolean, lockModes: number) {
    const keyName = USB_HID_MAP[usbHid];
    if (!keyName) {
      console.error("Unknown USB HID code " + usbHid);
      return;
    }
    const events = this.mapKeyNameToEvents(keyName, down);
    if (!events) return;
    const isNumpad = NUMPAD_KEYS.has(keyName);
    const isChar = CHAR_KEYS.has(keyName);
    if (isChar || isNumpad) {
      applyLockModes(events, lockModes, isNumpad, isChar);
    }
    for (const ev of events) {
      this._ws?.sendMessage({ key_event: ev });
    }
  }

  mapKeyNameToEvents(keyName: string, down: boolean): message.KeyEvent[] | null {
    const platform = this._peerInfo?.platform || "";
    const scancodeMap = platform === "Windows" ? WIN_SCANCODE_MAP
      : platform === "Linux" ? LINUX_SCANCODE_MAP
      : platform === "Mac OS" ? MACOS_SCANCODE_MAP
      : platform === "Android" ? ANDROID_SCANCODE_MAP
      : WIN_SCANCODE_MAP;
    const code = scancodeMap[keyName];
    if (code == null) {
      console.error("Unknown key name " + keyName + " for platform " + platform);
      return null;
    }
    return [message.KeyEvent.fromPartial({ chr: code, mode: message.KeyboardMode.Map, down, press: false })];
  }

  ctrlAltDel() {
    const key_event = message.KeyEvent.fromPartial({ down: true });
    if (this._peerInfo?.platform == "Windows") {
      key_event.control_key = message.ControlKey.CtrlAltDel;
    } else {
      key_event.control_key = message.ControlKey.Delete;
      key_event.modifiers = this.getMod(true, true, false, false);
    }
    this._ws?.sendMessage({ key_event });
  }

  restart() {
    const misc = message.Misc.fromPartial({});
    misc.restart_remote_device = true;
    this._ws?.sendMessage({ misc });
  }

  inputString(seq: string) {
    const key_event = message.KeyEvent.fromPartial({ seq });
    this._ws?.sendMessage({ key_event });
  }

  send2fa(code: string) {
    const auth_2fa = message.Auth2FA.fromPartial({ code });
    this._ws?.sendMessage({ auth_2fa });
  }

  _captureDisplays({ add, sub, set }: {
    add?: number[], sub?: number[], set?: number[]
  }) {
    const capture_displays = message.CaptureDisplays.fromPartial({ add, sub, set });
    const misc = message.Misc.fromPartial({ capture_displays });
    this._ws?.sendMessage({ misc });
  }

  switchDisplay(v: string) {
    try {
      const obj = JSON.parse(v);
      const value = obj.value;
      const isDesktop = obj.isDesktop;
      if (value.length == 1) {
        const switch_display = message.SwitchDisplay.fromPartial({ display: value[0] });
        const misc = message.Misc.fromPartial({ switch_display });
        this._ws?.sendMessage({ misc });

        if (!isDesktop) {
          this._captureDisplays({ set: value });
        } else {
          // If support merging images, check_remove_unused_displays() in ui_session_interface.rs
        }
      } else {
        this._captureDisplays({ set: value });
      }
    }
    catch (e) {
      console.log('Failed to switch display, invalid param "' + v + '"');
    }
  }

  elevateWithLogon(value: string) {
    try {
      const obj = JSON.parse(value);
      const logon = message.ElevationRequestWithLogon.fromPartial({
        username: obj.username,
        password: obj.password
      });
      const elevation_request = message.ElevationRequest.fromPartial({ logon });
      const misc = message.Misc.fromPartial({ elevation_request });
      this._ws?.sendMessage({ misc });
    }
    catch (e) {
      console.log('Failed to elevate with logon, invalid param "' + value + '"');
    }
  }

  async inputOsPassword(seq: string) {
    this.inputMouse();
    await sleep(50);
    this.inputMouse(0, 3, 3);
    await sleep(50);
    this.inputMouse(1 | (1 << 3));
    this.inputMouse(2 | (1 << 3));
    await sleep(1200);
    const key_event = message.KeyEvent.fromPartial({ press: true, seq });
    this._ws?.sendMessage({ key_event });
  }

  lockScreen() {
    const key_event = message.KeyEvent.fromPartial({
      down: true,
      control_key: message.ControlKey.LockScreen,
    });
    this._ws?.sendMessage({ key_event });
  }

  getMod(alt: Boolean, ctrl: Boolean, shift: Boolean, command: Boolean) {
    const mod: message.ControlKey[] = [];
    if (alt) mod.push(message.ControlKey.Alt);
    if (ctrl) mod.push(message.ControlKey.Control);
    if (shift) mod.push(message.ControlKey.Shift);
    if (command) mod.push(message.ControlKey.Meta);
    return mod;
  }

  inputMouse(
    mask: number = 0,
    x: number = 0,
    y: number = 0,
    alt: Boolean = false,
    ctrl: Boolean = false,
    shift: Boolean = false,
    command: Boolean = false
  ) {
    const mouse_event = message.MouseEvent.fromPartial({
      mask,
      x,
      y,
      modifiers: this.getMod(alt, ctrl, shift, command),
    });
    this._ws?.sendMessage({ mouse_event });
  }

  toggleOption(name: string) {

    //   } else if name == "block-input" {
    //     option.block_input = BoolOption::Yes.into();
    // } else if name == "unblock-input" {
    //     option.block_input = BoolOption::No.into();
    // } else if name == "show-quality-monitor" {
    //     config.show_quality_monitor.v = !config.show_quality_monitor.v;
    // } else if name == "allow_swap_key" {
    //     config.allow_swap_key.v = !config.allow_swap_key.v;
    // } else if name == "view-only" {
    //     config.view_only.v = !config.view_only.v;
    //     let f = |b: bool| {
    //         if b {
    //             BoolOption::Yes.into()
    //         } else {
    //             BoolOption::No.into()
    //         }
    //     };
    //     if config.view_only.v {
    //         option.disable_keyboard = f(true);
    //         option.disable_clipboard = f(true);
    //         option.show_remote_cursor = f(true);
    //         option.enable_file_transfer = f(false);
    //         option.lock_after_session_end = f(false);
    //     } else {
    //         option.disable_keyboard = f(false);
    //         option.disable_clipboard = f(self.get_toggle_option("disable-clipboard"));
    //         option.show_remote_cursor = f(self.get_toggle_option("show-remote-cursor"));
    //         option.enable_file_transfer = f(self.config.enable_file_transfer.v);
    //         option.lock_after_session_end = f(self.config.lock_after_session_end.v);
    //     }
    // } else {
    //     let is_set = self
    //         .options
    //         .get(&name)
    //         .map(|o| !o.is_empty())
    //         .unwrap_or(false);
    //     if is_set {
    //         self.config.options.remove(&name);
    //     } else {
    //         self.config.options.insert(name, "Y".to_owned());
    //     }
    //     self.config.store(&self.id);
    //     return None;
    // }

    const v = !this._options[name];
    const option = message.OptionMessage.fromPartial({});
    const v2 = v
      ? message.OptionMessage_BoolOption.Yes
      : message.OptionMessage_BoolOption.No;
    switch (name) {
      case "show-remote-cursor":
        option.show_remote_cursor = v2;
        break;
      case "disable-audio":
        option.disable_audio = v2;
        break;
      case "disable-clipboard":
        option.disable_clipboard = v2;
        break;
      case "lock-after-session-end":
        option.lock_after_session_end = v2;
        break;
      case "privacy-mode":
        option.privacy_mode = v2;
        break;
      case "enable-file-copy-paste":
        option.enable_file_transfer = v2;
        break;
      case "block-input":
        option.block_input = message.OptionMessage_BoolOption.Yes;
        break;
      case "unblock-input":
        option.block_input = message.OptionMessage_BoolOption.No;
        break;
      case "show-quality-monitor":
      case "allow-swap-key":
        break;
      case "view-only":
        if (v) {
          option.disable_keyboard = message.OptionMessage_BoolOption.Yes;
          option.disable_clipboard = message.OptionMessage_BoolOption.Yes;
          option.show_remote_cursor = message.OptionMessage_BoolOption.Yes;
          option.enable_file_transfer = message.OptionMessage_BoolOption.No;
          option.lock_after_session_end = message.OptionMessage_BoolOption.No;
        } else {
          option.disable_keyboard = message.OptionMessage_BoolOption.No;
          option.disable_clipboard = this.getToggleOption("disable-clipboard")
            ? message.OptionMessage_BoolOption.Yes
            : message.OptionMessage_BoolOption.No;
          option.show_remote_cursor = this.getToggleOption("show-remote-cursor")
            ? message.OptionMessage_BoolOption.Yes
            : message.OptionMessage_BoolOption.No;
          option.enable_file_transfer = this.getToggleOption("enable-file-copy-paste")
            ? message.OptionMessage_BoolOption.Yes
            : message.OptionMessage_BoolOption.No;
          option.lock_after_session_end = this.getToggleOption("lock-after-session-end")
            ? message.OptionMessage_BoolOption.Yes
            : message.OptionMessage_BoolOption.No;
        }
        break;
      default:
        this.setOption(name, this._options[name] ? undefined : "Y");
        return;
    }
    if (name.indexOf("block-input") < 0) this.setOption(name, v);
    const misc = message.Misc.fromPartial({ option });
    this._ws?.sendMessage({ misc });
  }

  togglePrivacyMode(value: string) {
    try {
      const obj = JSON.parse(value);
      const toggle_privacy_mode = message.TogglePrivacyMode.fromPartial({
        impl_key: obj.impl_key,
        on: obj.on,
      });
      const misc = message.Misc.fromPartial({ toggle_privacy_mode });
      this._ws?.sendMessage({ misc });
    } catch (e) {
      console.log('Failed to toggle privacy mode, invalid param "' + value + '"')
    }
  }

  getImageQuality() {
    return this.getOption("image-quality");
  }

  getImageQualityEnum(
    value: string,
    ignoreDefault: Boolean
  ): message.ImageQuality | undefined {
    switch (value) {
      case "low":
        return message.ImageQuality.Low;
      case "best":
        return message.ImageQuality.Best;
      case "balanced":
        return ignoreDefault ? undefined : message.ImageQuality.Balanced;
      default:
        return undefined;
    }
  }

  setImageQuality(value: string) {
    this.setOption("image-quality", value);
    const image_quality = this.getImageQualityEnum(value, false);
    if (image_quality == undefined) return;
    const option = message.OptionMessage.fromPartial({ image_quality });
    const misc = message.Misc.fromPartial({ option });
    this._ws?.sendMessage({ misc });
  }

  loadVideoDecoder() {
    this._videoDecoder?.close();
    loadVp9((decoder: any) => {
      this._videoDecoder = decoder;
      console.log("vp9 loaded");
      console.log('The decoder: ', decoder);
    });
  }
}

function testDelay() {
  var nearest = "";
  HOSTS.forEach((host) => {
    const now = new Date().getTime();
    new Websock(getrUriFromRs(host), true).open().then(() => {
      console.log("latency of " + host + ": " + (new Date().getTime() - now));
      if (!nearest) {
        HOST = host;
        localStorage.setItem("rendezvous-server", host);
      }
    });
  });
}

testDelay();

function getDefaultUri(isRelay: Boolean = false): string {
  const host = localStorage.getItem("custom-rendezvous-server");
  return getrUriFromRs(host || HOST, isRelay);
}

function getrUriFromRs(
  uri: string,
  isRelay: Boolean = false,
  roffset: number = 0
): string {
  if (uri.indexOf(":") > 0) {
    const tmp = uri.split(":");
    const port = parseInt(tmp[1]);
    uri = tmp[0] + ":" + (port + (isRelay ? roffset || 3 : 2));
  } else {
    uri += ":" + (PORT + (isRelay ? 3 : 2));
  }
  return SCHEMA + uri;
}

function hash(datas: (string | Uint8Array)[]): Uint8Array {
  const hasher = new sha256.Hash();
  datas.forEach((data) => {
    if (typeof data == "string") {
      data = new TextEncoder().encode(data);
    }
    return hasher.update(data);
  });
  return hasher.digest();
}
