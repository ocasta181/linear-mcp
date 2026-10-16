import { LinearClient } from '@linear/sdk';
import { randomUUID } from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * Solution Attempts:
 * 
 * 1. OAuth Flow with Browser (Initial Attempt)
 * - Used browser redirect and local server for OAuth flow
 * - Issues: Browser extensions interfering, CORS issues
 * - Status: Failed - Browser extensions and CORS blocking requests
 * 
 * 2. Personal Access Token (Current Attempt)
 * - Using API Key for initial integration tests
 * - Simpler approach without browser interaction
 * - Status: Working - Successfully authenticates and makes API calls
 * 
 * 3. Direct OAuth Token Exchange (Current Attempt)
 * - Using form-urlencoded content type as required by Linear
 * - Status: In Progress - Testing token exchange
 */

export interface OAuthConfig {
  type: 'oauth';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface APIKeyConfig {
  type: 'api';
  apiKey: string;
}

export type AuthConfig = OAuthConfig | APIKeyConfig;

export interface TokenData {
  apiKey: string;
  refreshToken: string;
  expiresAt: number;
}

export class LinearAuth {
  private static readonly OAUTH_AUTH_URL = 'https://linear.app/oauth';
  private static readonly OAUTH_TOKEN_URL = 'https://api.linear.app';
  private static readonly STATE_TTL_MS = 10 * 60 * 1000;
  private config?: AuthConfig;
  private tokenData?: TokenData;
  private linearClient?: LinearClient;
  private pendingState?: { value: string; expiresAt: number };
  private authenticationVersion = 0;
  private refreshPromise?: Promise<void>;

  constructor() {}

  public getAuthorizationUrl(): string {
    if (!this.config || this.config.type !== 'oauth') {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'OAuth config not initialized'
      );
    }

    const state = this.generateState();
    this.pendingState = { value: state, expiresAt: Date.now() + LinearAuth.STATE_TTL_MS };
    this.authenticationVersion++;

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'read,write,issues:create,offline_access',
      actor: 'application', // Enable OAuth Actor Authorization
      state,
      access_type: 'offline',
    });

    return `${LinearAuth.OAUTH_AUTH_URL}/authorize?${params.toString()}`;
  }

  public async handleCallback(code: string, state: string): Promise<void> {
    if (!this.config || this.config.type !== 'oauth') {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'OAuth config not initialized'
      );
    }

    if (!state || !this.pendingState || state !== this.pendingState.value ||
        Date.now() >= this.pendingState.expiresAt) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Invalid or expired OAuth state. Start a new authorization flow.'
      );
    }

    // Consume the state before the first await so concurrent callbacks cannot replay it.
    this.pendingState = undefined;
    const version = this.authenticationVersion;
    const config = this.config;

    try {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code,
        access_type: 'offline'
      });

      const response = await fetch(`${LinearAuth.OAUTH_TOKEN_URL}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: params.toString()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token request failed: ${response.statusText}. Response: ${errorText}`);
      }

      const data = await response.json();
      this.verifyAuthenticationVersion(version);
      this.tokenData = {
        apiKey: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };

      this.linearClient = new LinearClient({
        accessToken: this.tokenData.apiKey,
      });
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `OAuth token exchange failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  public async refreshAPIKey(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    if (!this.config || this.config.type !== 'oauth' || !this.tokenData?.refreshToken) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'OAuth not initialized or no refresh token available'
      );
    }

    const refreshPromise = this.refreshOAuthToken(
      this.config, this.tokenData.refreshToken, this.authenticationVersion
    );
    this.refreshPromise = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = undefined;
    }
  }

  private async refreshOAuthToken(config: OAuthConfig, refreshToken: string, version: number): Promise<void> {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken
      });

      const response = await fetch(`${LinearAuth.OAUTH_TOKEN_URL}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: params.toString()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed: ${response.statusText}. Response: ${errorText}`);
      }

      const data = await response.json();
      this.verifyAuthenticationVersion(version);
      this.tokenData = {
        apiKey: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
      };

      this.linearClient = new LinearClient({
        accessToken: this.tokenData.apiKey,
      });
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  public initialize(config: AuthConfig): void {
    if (config.type === 'oauth' && (!config.clientId || !config.clientSecret || !config.redirectUri)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Missing required OAuth parameters: clientId, clientSecret, redirectUri'
      );
    }

    this.config = config;
    this.pendingState = undefined;
    this.tokenData = undefined;
    this.linearClient = undefined;
    this.refreshPromise = undefined;
    this.authenticationVersion++;

    if (config.type === 'api') {
      // Personal Access Token flow
      this.tokenData = {
        apiKey: config.apiKey,
        refreshToken: '', // Not needed for API Key
        expiresAt: Number.MAX_SAFE_INTEGER, // API Keys don't expire
      };
      this.linearClient = new LinearClient({
        apiKey: config.apiKey,
      });
    }
  }

  public getClient(): LinearClient {
    if (!this.linearClient) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Linear client not initialized'
      );
    }
    return this.linearClient;
  }

  public isAuthenticated(): boolean {
    return !!this.linearClient && !!this.tokenData;
  }

  public needsTokenRefresh(): boolean {
    if (!this.tokenData || !this.config || this.config.type === 'api') return false;
    return Date.now() >= this.tokenData.expiresAt - 300000; // Refresh 5 minutes before expiry
  }

  // For testing purposes
  public setTokenData(tokenData: TokenData): void {
    this.tokenData = tokenData;
    this.linearClient = new LinearClient(this.config?.type === 'oauth'
      ? { accessToken: tokenData.apiKey }
      : { apiKey: tokenData.apiKey });
  }

  private verifyAuthenticationVersion(version: number): void {
    if (version !== this.authenticationVersion) {
      throw new Error('Authentication changed while the token request was in progress. Start a new authorization flow.');
    }
  }

  private generateState(): string {
    // OAuth state must be cryptographically unpredictable and verified on callback.
    return randomUUID();
  }
}
