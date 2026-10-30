"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser side of a video visit: plain WebRTC between the clinician and the
 * client, introduced through the visit's Amazon Kinesis Video Streams
 * signaling channel. The clinician is the channel's master and answers; the
 * client is a viewer and makes the offer, retrying until the call connects.
 */

export type VideoConnection = {
  signalingUrl: string;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  role: "MASTER" | "VIEWER";
  clientId: string | null;
};

export type VideoCallState = "starting" | "waiting" | "connected" | "failed";

type Signal = {
  /** Which attempt this belongs to, so stale answers and candidates are dropped. */
  callId: string;
  type?: RTCSdpType;
  sdp?: string;
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};

/** TURN credentials last about five minutes; refresh before reusing them. */
const ICE_SERVERS_MAX_AGE_MS = 4 * 60 * 1000;
/** A viewer re-offers if the call hasn't connected in this long. */
const OFFER_RETRY_MS = 8_000;
/** How long a dropped connection may try to recover on its own. */
const DISCONNECT_GRACE_MS = 6_000;
const RECONNECT_DELAY_MS = 1_500;
const MAX_RECONNECT_ATTEMPTS = 6;

const encode = (value: Signal) => btoa(JSON.stringify(value));
function decode(payload: string): Signal | null {
  try {
    const value = JSON.parse(atob(payload)) as Signal;
    return typeof value?.callId === "string" ? value : null;
  } catch {
    return null;
  }
}
const newCallId = () => Math.random().toString(36).slice(2, 12);

export function useVideoCall(input: {
  connection: VideoConnection;
  /** Ask the server for a freshly signed connection to the same visit. */
  refreshConnection: () => Promise<VideoConnection>;
}) {
  const [state, setState] = useState<VideoCallState>("starting");
  const [failure, setFailure] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);

  const refresh = useRef(input.refreshConnection);
  refresh.current = input.refreshConnection;
  const initial = useRef(input.connection);

  useEffect(() => {
    const role = initial.current.role;
    let connection = initial.current;
    let fetchedAt = Date.now();
    let closed = false;
    let socket: WebSocket | null = null;
    let local: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    /** The attempt being set up or in progress; other signals are stale. */
    let callId: string | null = null;
    /** The viewer the clinician is talking to. */
    let peerClientId: string | null = null;
    let pending: { callId: string; candidate: RTCIceCandidateInit }[] = [];
    let reconnectAttempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
      if (timer) clearTimeout(timer);
    };

    async function freshConnection(): Promise<VideoConnection> {
      if (Date.now() - fetchedAt < ICE_SERVERS_MAX_AGE_MS) return connection;
      connection = await refresh.current();
      fetchedAt = Date.now();
      return connection;
    }

    function send(action: "SDP_OFFER" | "SDP_ANSWER" | "ICE_CANDIDATE", signal: Signal) {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          action,
          messagePayload: encode(signal),
          ...(role === "MASTER" && peerClientId ? { recipientClientId: peerClientId } : {}),
        }),
      );
    }

    function closePeer() {
      clearTimer(disconnectTimer);
      disconnectTimer = null;
      if (peer) {
        peer.onicecandidate = null;
        peer.ontrack = null;
        peer.onconnectionstatechange = null;
        peer.close();
      }
      peer = null;
      if (!closed) setRemoteStream(null);
    }

    function newPeer(iceServers: VideoConnection["iceServers"], id: string) {
      closePeer();
      const pc = new RTCPeerConnection({ iceServers });
      peer = pc;
      for (const track of local?.getTracks() ?? []) pc.addTrack(track, local!);
      const remote = new MediaStream();
      pc.ontrack = (event) => {
        remote.addTrack(event.track);
        setRemoteStream(new MediaStream(remote.getTracks()));
      };
      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        send("ICE_CANDIDATE", {
          callId: id,
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
      };
      pc.onconnectionstatechange = () => {
        if (peer !== pc) return;
        if (pc.connectionState === "connected") {
          clearTimer(disconnectTimer);
          disconnectTimer = null;
          clearTimer(retryTimer);
          retryTimer = null;
          setState("connected");
        } else if (pc.connectionState === "failed") {
          lost();
        } else if (pc.connectionState === "disconnected") {
          clearTimer(disconnectTimer);
          disconnectTimer = setTimeout(() => {
            if (peer === pc && pc.connectionState !== "connected") lost();
          }, DISCONNECT_GRACE_MS);
        }
      };
      return pc;
    }

    /** The other person dropped; wait for them (master) or call again (viewer). */
    function lost() {
      closePeer();
      setState("waiting");
      if (role === "VIEWER") void offer();
    }

    async function flush(pc: RTCPeerConnection, id: string) {
      const queued = pending.filter((entry) => entry.callId === id);
      pending = [];
      for (const entry of queued) await pc.addIceCandidate(entry.candidate).catch(() => {});
    }

    async function offer() {
      clearTimer(retryTimer);
      const retry = () => {
        if (closed || peer?.connectionState === "connected") return;
        // Still working through network paths; give it longer.
        if (peer?.connectionState === "connecting") retryTimer = setTimeout(retry, OFFER_RETRY_MS);
        else void offer();
      };
      retryTimer = setTimeout(retry, OFFER_RETRY_MS);
      if (socket?.readyState !== WebSocket.OPEN) return;
      try {
        const { iceServers } = await freshConnection();
        if (closed) return;
        const id = newCallId();
        callId = id;
        const pc = newPeer(iceServers, id);
        const description = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(description);
        send("SDP_OFFER", { callId: id, type: "offer", sdp: description.sdp });
      } catch {
        // The retry timer tries again.
      }
    }

    async function answer(signal: Signal, from: string | undefined) {
      if (!signal.sdp || !from) return;
      // The newest offer wins: it is the viewer's latest attempt.
      peerClientId = from;
      callId = signal.callId;
      try {
        const { iceServers } = await freshConnection();
        if (closed || callId !== signal.callId) return;
        const pc = newPeer(iceServers, signal.callId);
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        await flush(pc, signal.callId);
        const description = await pc.createAnswer();
        await pc.setLocalDescription(description);
        send("SDP_ANSWER", { callId: signal.callId, type: "answer", sdp: description.sdp });
      } catch {
        closePeer();
      }
    }

    async function onMessage(raw: string) {
      let message: { messageType?: string; messagePayload?: string; senderClientId?: string };
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (!message.messagePayload) return;
      const signal = decode(message.messagePayload);
      if (!signal) return;
      if (message.messageType === "SDP_OFFER" && role === "MASTER") {
        await answer(signal, message.senderClientId);
      } else if (message.messageType === "SDP_ANSWER" && role === "VIEWER") {
        const pc = peer;
        if (!pc || signal.callId !== callId || !signal.sdp) return;
        if (pc.signalingState !== "have-local-offer") return;
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp }).catch(() => {});
        await flush(pc, signal.callId);
      } else if (message.messageType === "ICE_CANDIDATE" && signal.candidate) {
        if (signal.callId !== callId) return;
        if (role === "MASTER" && message.senderClientId !== peerClientId) return;
        const candidate = {
          candidate: signal.candidate,
          sdpMid: signal.sdpMid ?? null,
          sdpMLineIndex: signal.sdpMLineIndex ?? null,
        };
        if (peer?.remoteDescription) {
          await peer.addIceCandidate(candidate).catch(() => {});
        } else {
          // Candidates can arrive while the offer or answer is being applied.
          pending.push({ callId: signal.callId, candidate });
        }
      }
    }

    function connectSocket(url: string) {
      if (closed) return;
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => {
        reconnectAttempts = 0;
        if (role === "VIEWER" && peer?.connectionState !== "connected") void offer();
        else if (role === "MASTER" && !peer) setState("waiting");
      };
      ws.onmessage = (event) => void onMessage(String(event.data));
      ws.onclose = () => {
        if (closed || socket !== ws) return;
        reconnect();
      };
    }

    /**
     * Signaling links are short-lived and idle ones get closed; replace a
     * dropped one without touching a call that is already connected.
     */
    function reconnect() {
      clearTimer(reconnectTimer);
      reconnectAttempts += 1;
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS && peer?.connectionState !== "connected") {
        closePeer();
        setState("failed");
        setFailure("The video call disconnected.");
        return;
      }
      const delay = RECONNECT_DELAY_MS * Math.min(reconnectAttempts, 8);
      reconnectTimer = setTimeout(async () => {
        try {
          connection = await refresh.current();
          fetchedAt = Date.now();
          connectSocket(connection.signalingUrl);
        } catch {
          if (!closed) reconnect();
        }
      }, delay);
    }

    async function begin() {
      try {
        local = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        });
      } catch {
        try {
          local = await navigator.mediaDevices.getUserMedia({ audio: true });
          setCameraOn(false);
        } catch {
          setState("failed");
          setFailure("Allow camera and microphone access to join the video call.");
          return;
        }
      }
      if (closed) {
        for (const track of local.getTracks()) track.stop();
        return;
      }
      setLocalStream(local);
      setState("waiting");
      connectSocket(connection.signalingUrl);
    }
    void begin();

    return () => {
      closed = true;
      clearTimer(retryTimer);
      clearTimer(reconnectTimer);
      closePeer();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      for (const track of local?.getTracks() ?? []) track.stop();
    };
  }, []);

  const toggleMic = useCallback(() => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, [localStream]);

  const toggleCamera = useCallback(() => {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
  }, [localStream]);

  return {
    state,
    failure,
    localStream,
    remoteStream,
    localAudioTrack: localStream?.getAudioTracks()[0] ?? null,
    remoteAudioTrack: remoteStream?.getAudioTracks()[0] ?? null,
    micOn,
    cameraOn,
    toggleMic,
    toggleCamera,
  };
}
