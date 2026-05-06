import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { spawn } from "node:child_process";
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  exchangeCode,
  extractCodeFromPaste,
  generateCodeVerifier,
  generateState,
  type OAuthSession
} from "../llm/oauth.js";

export function tryLaunchBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // Browser launch is a UX nicety; the URL is already printed to stdout as the safety net.
  }
}

export interface OAuthEmbedProps {
  url: string;
  expectedState: string;
  codeVerifier: string;
  onDone: (session: OAuthSession) => void;
  onError: (err: Error) => void;
}

/**
 * Embeddable OAuth paste-screen for use inside an existing Ink app (e.g. the wizard).
 * Does NOT call `useApp().exit()` — the host owns the app lifecycle.
 */
export const OAuthEmbed: React.FC<OAuthEmbedProps> = ({ url, expectedState, codeVerifier, onDone, onError }) => {
  const [paste, setPaste] = useState("");
  const [phase, setPhase] = useState<"input" | "exchanging" | "error">("input");
  const [errorMsg, setErrorMsg] = useState<string>("");

  const submit = async (raw: string) => {
    let code: string;
    try {
      code = extractCodeFromPaste(raw, expectedState);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setPaste("");
      setPhase("error");
      return;
    }
    setPhase("exchanging");
    try {
      const session = await exchangeCode({ code, codeVerifier });
      onDone(session);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setPaste("");
      setPhase("error");
      onError(e instanceof Error ? e : new Error(msg));
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold>Anthropic OAuth (Claude Pro/Max)</Text>
      <Text>Открой эту ссылку в браузере и войди в Claude:</Text>
      <Text color="cyan">{url}</Text>
      <Box marginTop={1} />
      <Text>Вставь полный URL со страницы успеха — он содержит state-проверку. (Только code тоже сработает, но без CSRF-защиты.)</Text>
      {phase === "input" && (
        <Box>
          <Text>{"› "}</Text>
          <TextInput value={paste} onChange={setPaste} onSubmit={submit} />
        </Box>
      )}
      {phase === "exchanging" && (
        <Box>
          <Spinner type="dots" />
          <Text> Меняем code на токены…</Text>
        </Box>
      )}
      {phase === "error" && (
        <Box flexDirection="column">
          <Text color="red">Ошибка: {errorMsg}</Text>
          <Text dimColor>Попробуй ещё раз — вставь полный URL или просто code.</Text>
          <Box>
            <Text>{"› "}</Text>
            <TextInput value={paste} onChange={setPaste} onSubmit={submit} />
          </Box>
        </Box>
      )}
    </Box>
  );
};

export interface PreparedOAuthRequest {
  url: string;
  codeVerifier: string;
  state: string;
}

export function prepareOAuthRequest(): PreparedOAuthRequest {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeS256(codeVerifier);
  const state = generateState();
  const url = buildAuthorizeUrl({ codeChallenge, state });
  return { url, codeVerifier, state };
}

interface StandaloneScreenProps extends OAuthEmbedProps {}

const StandaloneOAuthScreen: React.FC<StandaloneScreenProps> = (props) => {
  const { exit } = useApp();
  return (
    <OAuthEmbed
      {...props}
      onDone={(session) => {
        props.onDone(session);
        exit();
      }}
      onError={(err) => {
        props.onError(err);
        exit();
      }}
    />
  );
};

export interface RunOAuthFlowOptions {
  noBrowser?: boolean;
}

export async function runOAuthFlow(opts: RunOAuthFlowOptions = {}): Promise<OAuthSession> {
  const prep = prepareOAuthRequest();

  process.stdout.write(`\n=== Anthropic OAuth ===\nОткрой эту ссылку в браузере:\n${prep.url}\n\n`);

  if (!opts.noBrowser) {
    tryLaunchBrowser(prep.url);
  }

  return new Promise<OAuthSession>((resolve, reject) => {
    const { unmount, waitUntilExit } = render(
      <StandaloneOAuthScreen
        url={prep.url}
        expectedState={prep.state}
        codeVerifier={prep.codeVerifier}
        onDone={(session) => resolve(session)}
        onError={(err) => reject(err)}
      />
    );
    waitUntilExit().then(() => unmount()).catch(() => unmount());
  });
}
