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
  private config?: AuthConfig;
  private tokenData?: TokenData;
  private linearClient?: LinearClient;

  constructor() {}

  public getAuthorizationUrl(): string {
    if (!this.config || this.config.type !== 'oauth') {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'OAuth config not initialized'
      );
    }

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'read,write,issues:create,offline_access',
      actor: 'application', // Enable OAuth Actor Authorization
      state: this.generateState(),
      access_type: 'offline',
    });

    return `${LinearAuth.OAUTH_AUTH_URL}/authorize?${params.toString()}`;
  }

  public async handleCallback(code: string): Promise<void> {
    if (!this.config || this.config.type !== 'oauth') {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'OAuth config not initialized'
      );
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
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
      this.tokenData = {
        apiKey: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };

      this.linearClient = new LinearClient({
        apiKey: this.tokenData.apiKey,
      });
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `OAuth token exchange failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  public async refreshAPIKey(): Promise<void> {
    if (!this.config || this.config.type !== 'oauth' || !this.tokenData?.refreshToken) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'OAuth not initialized or no refresh token available'
      );
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.tokenData.refreshToken
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
      this.tokenData = {
        apiKey: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };

      this.linearClient = new LinearClient({
        apiKey: this.tokenData.apiKey,
      });
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  public initialize(config: AuthConfig): void {
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
    } else {
      // OAuth flow
      if (!config.clientId || !config.clientSecret || !config.redirectUri) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Missing required OAuth parameters: clientId, clientSecret, redirectUri'
        );
      }
      this.config = config;
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
    this.linearClient = new LinearClient({
      apiKey: tokenData.apiKey,
    });
  }

  private generateState(): string {
    // OAuth `state` is the anti-CSRF bound to a single login attempt; it must be
    // cryptographically unpredictable. Math.random() is a PRNG seeded from the
    // current time (predictable), so it is not acceptable for this boundary.
    // Use a CSPRNG identifier instead (RFC 6749 s4.1.1 state requirement).
    return randomUUID();
  }
}
