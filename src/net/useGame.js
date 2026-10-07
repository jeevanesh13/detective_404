import { useCallback, useEffect, useRef, useState } from "react";
import { api, openStream, ApiError } from "./client.js";
import {
  loadPlayer,
  savePlayer,
  clearPlayer,
  loadAdmin,
  saveAdmin,
  clearAdmin,
  loadActiveRoom,
  saveActiveRoom,
} from "./session.js";

/**
 * Single source of truth for the whole platform.
 *
 * The active screen tells the hook which console it is (player or game
 * master); that console subscribes to the real-time stream. Every mutation
 * happens on the server and is pushed back, so the dashboard, the countdown
 * and every phone in the room stay in lock step.
 */
export function useGame(activeRole = "player") {
  const [playerSession, setPlayerSession] = useState(null);
  const [adminSession, setAdminSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [you, setYou] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [recent, setRecent] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [games, setGames] = useState([]);
  const [question, setQuestion] = useState(null);
  const [questionList, setQuestionList] = useState([]);
  const [activeRoom, setActiveRoom] = useState(() => loadActiveRoom());
  const [conn, setConn] = useState("idle");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [serverNow, setServerNow] = useState(() => Date.now());

  const offsetRef = useRef(0);
  const adminRef = useRef(null);
  adminRef.current = adminSession;
  const playerRef = useRef(null);
  playerRef.current = playerSession;
  const activeRoomRef = useRef(activeRoom);
  activeRoomRef.current = activeRoom;
  const roleRef = useRef(activeRole);
  roleRef.current = activeRole;

  const session = activeRole === "admin" ? adminSession : playerSession;

  const syncClock = (serverTime) => {
    if (typeof serverTime === "number") offsetRef.current = serverTime - Date.now();
  };

  /* ---------------- restore after refresh ---------------- */
  useEffect(() => {
    let alive = true;
    const storedPlayer = loadPlayer();
    const storedAdmin = loadAdmin();

    if (storedPlayer) setPlayerSession(storedPlayer);
    if (storedAdmin) setAdminSession(storedAdmin);

    (async () => {
      const tasks = [];
      if (storedPlayer) {
        tasks.push(
          api
            .session(storedPlayer.token)
            .then((data) => {
              if (!alive) return;
              setRoom(data.room);
              setYou(data.you);
              setPlayers(data.players || []);
              setLeaderboard(data.leaderboard || null);
              setQuestion(data.question || null);
              setQuestionList(data.questionList || []);
            })
            .catch((err) => {
              if (!alive) return;
              clearPlayer();
              setPlayerSession(null);
              if (err.status !== 0) setError("Your detective session expired. Please join again.");
            })
        );
      }
      if (storedAdmin) {
        tasks.push(
          api
            .session(storedAdmin.token)
            .then(async (data) => {
              if (!alive) return;
              setRooms(data.rooms || []);
              setGames(data.games || []);
              const remembered = loadActiveRoom();
              if (remembered && data.rooms?.some((r) => r.roomCode === remembered)) {
                const detail = await api.adminRoom(storedAdmin.token, remembered);
                if (!alive) return;
                setRoom(detail.room);
                setPlayers(detail.players || []);
                setRecent(detail.recent || []);
                setLeaderboard(detail.leaderboard?.length ? detail.leaderboard : null);
              }
            })
            .catch((err) => {
              if (!alive) return;
              clearAdmin();
              setAdminSession(null);
              if (err.status !== 0) setError("Your game master session expired. Sign in again.");
            })
        );
      }
      await Promise.allSettled(tasks);
      if (alive) setBooting(false);
    })();

    return () => {
      alive = false;
    };
  }, []);

  /* ---------------- live stream ---------------- */
  const sessionToken = session?.token || null;
  const streamRoom = activeRole === "admin" ? activeRoom : playerSession?.roomCode || null;
  const streamKey = `${activeRole}|${sessionToken || ""}|${streamRoom || ""}`;

  useEffect(() => {
    if (!sessionToken) {
      setConn("idle");
      return;
    }
    setConn("connecting");
    const close = openStream({
      roomCode: streamRoom,
      token: sessionToken,
      onStatus: (s) => setConn(s),
      onEvent: ({ event, data }) => {
        syncClock(data?.serverTime);
        if (event === "state") {
          if (data.error) {
            if (roleRef.current === "player") {
              clearPlayer();
              setPlayerSession(null);
              setError("That room is no longer available.");
            }
            return;
          }
          setRoom(data.room);
          if (Array.isArray(data.players)) setPlayers(data.players);
          if ("you" in data) setYou(data.you);
          if ("question" in data) setQuestion(data.question || null);
          if (Array.isArray(data.questionList)) setQuestionList(data.questionList);
          if (data.games) setGames(data.games);
          if (data.leaderboard) setLeaderboard(data.leaderboard);
          if (data.recent) setRecent(data.recent);
        } else if (event === "rooms") {
          setRooms(data.rooms || []);
          if (data.games) setGames(data.games);
        } else if (event === "game_over") {
          setLeaderboard(data.leaderboard || null);
          setNotice("TIME'S UP — the investigation is closed.");
        } else if (event === "tick") {
          setServerNow(Date.now() + offsetRef.current);
        }
      },
    });
    return close;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey]);

  /* ---------------- heartbeat keeps presence honest ---------------- */
  useEffect(() => {
    if (activeRole !== "player" || !playerSession?.token) return;
    const token = playerSession.token;
    const id = setInterval(() => {
      api.heartbeat(token).then(
        (d) => syncClock(d.serverTime),
        () => {}
      );
    }, 20_000);
    return () => clearInterval(id);
  }, [activeRole, playerSession?.token]);

  /* ---------------- local tick for a smooth countdown ---------------- */
  const hasClock = !!room && room.status !== "waiting";
  useEffect(() => {
    if (!hasClock) return;
    const id = setInterval(() => setServerNow(Date.now() + offsetRef.current), 400);
    return () => clearInterval(id);
  }, [hasClock]);

  /* ---------------- player actions ---------------- */
  const join = useCallback(async (playerName, roomCode) => {
    setBusy(true);
    setError(null);
    try {
      const data = await api.join(roomCode, playerName);
      const next = {
        role: "player",
        token: data.token,
        roomCode: data.room.roomCode,
        playerName: data.you.name,
        playerId: data.you.id,
      };
      savePlayer(next);
      setPlayerSession(next);
      setRoom(data.room);
      setYou(data.you);
      setPlayers(data.players || []);
      setLeaderboard(null);
      setQuestion(data.question || null);
      setQuestionList(data.questionList || []);
      setNotice(null);
      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const submitAnswer = useCallback(async (caseId, answer) => {
    const s = playerRef.current;
    if (!s) throw new ApiError("UNAUTHORIZED", "Join the room first.", 401);
    const data = await api.answer(s.token, caseId, answer);
    if (data.you) setYou(data.you);
    if (data.question) setQuestion(data.question);
    if (data.questionList) setQuestionList(data.questionList);
    return data;
  }, []);

  const advance = useCallback(async () => {
    const s = playerRef.current;
    if (!s) throw new ApiError("UNAUTHORIZED", "Join the room first.", 401);
    const data = await api.advance(s.token);
    if (data.you) setYou(data.you);
    if (data.room) setRoom(data.room);
    if (data.question !== undefined) setQuestion(data.question || null);
    if (data.questionList) setQuestionList(data.questionList);
    return data;
  }, []);

  const startGame = useCallback(async () => {
    const s = playerRef.current;
    if (!s) throw new ApiError("UNAUTHORIZED", "Join the room first.", 401);
    const data = await api.startGame(s.token);
    // One shared room state: everybody in the room moves to the same case,
    // the same question list and the same countdown.
    if (data.room) setRoom(data.room);
    if (data.players) setPlayers(data.players);
    if (data.you) setYou(data.you);
    if (data.question !== undefined) setQuestion(data.question || null);
    if (data.questionList) setQuestionList(data.questionList);
    return data;
  }, []);

  const leave = useCallback(() => {
    if (roleRef.current === "admin") {
      clearAdmin();
      setAdminSession(null);
      setGames([]);
    } else {
      clearPlayer();
      setPlayerSession(null);
      setRoom(null);
      setYou(null);
      setLeaderboard(null);
      setQuestion(null);
      setQuestionList([]);
    }
    setPlayers([]);
    setRecent([]);
    setError(null);
    setNotice(null);
    setConn("idle");
  }, []);

  /* ---------------- game master actions ---------------- */
  const adminLogin = useCallback(async (username, password) => {
    setBusy(true);
    setError(null);
    try {
      const data = await api.adminLogin(username, password);
      const next = {
        role: "admin",
        token: data.token,
        username: data.admin.username,
        adminId: data.admin.id,
      };
      saveAdmin(next);
      setAdminSession(next);
      setRooms(data.rooms || []);
      setGames(data.games || []);
      const remembered = loadActiveRoom();
      const valid = remembered && data.rooms?.some((r) => r.roomCode === remembered);
      setActiveRoom(valid ? remembered : null);
      if (valid) {
        const detail = await api.adminRoom(data.token, remembered);
        setRoom(detail.room);
        setPlayers(detail.players || []);
        setRecent(detail.recent || []);
        setLeaderboard(detail.leaderboard?.length ? detail.leaderboard : null);
      } else {
        setRoom(null);
        setPlayers([]);
        setRecent([]);
        setLeaderboard(null);
      }
      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const selectRoom = useCallback(async (code) => {
    saveActiveRoom(code);
    setActiveRoom(code);
    const s = adminRef.current;
    if (!s) return;
    setBusy(true);
    try {
      const data = await api.adminRoom(s.token, code);
      setRoom(data.room);
      setPlayers(data.players || []);
      setRecent(data.recent || []);
      setLeaderboard(data.leaderboard?.length ? data.leaderboard : null);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  const createRoom = useCallback(
    async (roomName, duration) => {
      const s = adminRef.current;
      if (!s) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
      setBusy(true);
      setError(null);
      try {
        const data = await api.adminCreateRoom(s.token, roomName, duration);
        setRooms(data.rooms || []);
        await selectRoom(data.room.roomCode);
        return data.room;
      } catch (err) {
        setError(err.message);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [selectRoom]
  );

  /** Permanently delete one room (and only that room) on the game master's behalf. */
  const deleteRoom = useCallback(
    async (code) => {
      const s = adminRef.current;
      if (!s) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
      setBusy(true);
      setError(null);
      try {
        const data = await api.adminDeleteRoom(s.token, code);
        setRooms(data.rooms || []);
        if (activeRoomRef.current === code) {
          saveActiveRoom(null);
          setActiveRoom(null);
          setRoom(null);
          setPlayers([]);
          setRecent([]);
          setLeaderboard(null);
        }
        return data;
      } catch (err) {
        setError(err.message);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const adminAction = useCallback(async (action, payload = {}) => {
    const s = adminRef.current;
    if (!s) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
    const code = payload.code || activeRoomRef.current;
    setBusy(true);
    setError(null);
    try {
      const data = await api.adminAction(action, s.token, { ...payload, code });
      if (data.room) setRoom(data.room);
      if (data.rooms) setRooms(data.rooms);
      setLeaderboard(data.leaderboard || null);
      if (action === "reset") {
        setRecent([]);
        setLeaderboard(null);
      }
      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshRooms = useCallback(async () => {
    const s = adminRef.current;
    if (!s) return;
    try {
      const data = await api.adminRooms(s.token);
      setRooms(data.rooms || []);
      if (data.games) setGames(data.games);
    } catch {
      /* transient */
    }
  }, []);

  /* ---------------- Game Builder ---------------- */
  const gamesCall = useCallback(async (fn, ...args) => {
    const s = adminRef.current;
    if (!s) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
    setBusy(true);
    setError(null);
    try {
      const data = await fn(s.token, ...args);
      if (data.games) setGames(data.games);
      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const loadGame = useCallback((id) => gamesCall(api.game, id), [gamesCall]);
  const createGame = useCallback(
    (payload) => gamesCall(api.createGame, payload),
    [gamesCall]
  );
  const saveGame = useCallback((payload) => gamesCall(api.saveGame, payload), [gamesCall]);
  const publishGame = useCallback((id, status) => gamesCall(api.publishGame, id, status), [gamesCall]);
  const removeGame = useCallback((id) => gamesCall(api.deleteGame, id), [gamesCall]);
  const saveCase = useCallback((payload) => gamesCall(api.saveCase, payload), [gamesCall]);
  const removeCase = useCallback((gameId, caseId) => gamesCall(api.deleteCase, gameId, caseId), [gamesCall]);
  const moveCase = useCallback(
    (gameId, caseId, direction) => gamesCall(api.moveCase, gameId, caseId, direction),
    [gamesCall]
  );

  /** Read a File from the picker/phone camera and hand it to the server. */
  const uploadImage = useCallback(async (file) => {
    const s = adminRef.current;
    if (!s) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
    if (!file) throw new ApiError("BAD_IMAGE", "Choose an image first.");
    if (file.size > 6 * 1024 * 1024)
      throw new ApiError("IMAGE_TOO_LARGE", "Images must be 6 MB or smaller.");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new ApiError("BAD_IMAGE", "That image could not be read."));
      reader.readAsDataURL(file);
    });
    setBusy(true);
    try {
      return await api.uploadImage(s.token, dataUrl);
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  /** Point a room at a game (server clears that room's progress). */
  const assignGame = useCallback((gameId) => adminAction("game", { gameId: gameId || "" }), [adminAction]);

  /* keep the room list warm while the console is open */
  useEffect(() => {
    if (activeRole !== "admin" || !adminSession) return;
    const id = setInterval(refreshRooms, 5000);
    return () => clearInterval(id);
  }, [activeRole, adminSession, refreshRooms]);

  return {
    session,
    playerSession,
    adminSession,
    booting,
    room,
    players,
    you,
    leaderboard,
    recent,
    rooms,
    games,
    question,
    questionList,
    activeRoom,
    conn,
    error,
    notice,
    busy,
    serverNow,
    setError,
    setNotice,
    join,
    leave,
    submitAnswer,
    advance,
    startGame,
    adminLogin,
    selectRoom,
    createRoom,
    deleteRoom,
    adminAction,
    refreshRooms,
    loadGame,
    createGame,
    saveGame,
    publishGame,
    removeGame,
    saveCase,
    removeCase,
    moveCase,
    uploadImage,
    assignGame,
  };
}
