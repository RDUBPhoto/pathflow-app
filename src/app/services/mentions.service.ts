import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { MentionableUser, NotificationsApiService } from './notifications-api.service';

export type MentionDispatchOptions = {
  texts: Array<string | null | undefined>;
  route: string;
  entityType: string;
  entityId?: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type MentionDispatchResult = {
  tokens: string[];
  matched: MentionableUser[];
  sent: number;
  failed: number;
  unknown: string[];
};

@Injectable({ providedIn: 'root' })
export class MentionsService {
  private readonly notificationsApi = inject(NotificationsApiService);
  private readonly auth = inject(AuthService);

  private mentionableUsersCache: MentionableUser[] = [];
  private mentionableUsersCachedAt = 0;
  private readonly cacheMs = 5 * 60 * 1000;

  async dispatchFromText(options: MentionDispatchOptions): Promise<MentionDispatchResult> {
    const tokens = this.extractTokens(options.texts);
    if (!tokens.length) {
      return { tokens: [], matched: [], sent: 0, failed: 0, unknown: [] };
    }

    let users: MentionableUser[] = [];
    try {
      users = await this.loadMentionableUsers();
    } catch {
      return { tokens, matched: [], sent: 0, failed: 0, unknown: [...tokens] };
    }

    const lookup = this.buildLookup(users);
    const matchedMap = new Map<string, MentionableUser>();
    const unknown = new Set<string>();

    for (const token of tokens) {
      const matches = this.resolveToken(token, lookup);
      if (!matches.length) {
        unknown.add(token);
        continue;
      }
      for (const user of matches) {
        matchedMap.set(this.userKey(user), user);
      }
    }

    const matched = Array.from(matchedMap.values());
    if (!matched.length) {
      return { tokens, matched: [], sent: 0, failed: 0, unknown: [...unknown] };
    }

    const requests = matched.map(user =>
      firstValueFrom(this.notificationsApi.createMention({
        targetUserId: user.id || undefined,
        targetEmail: user.email || undefined,
        targetDisplayName: user.displayName || undefined,
        title: options.title,
        message: options.message,
        route: options.route,
        entityType: options.entityType,
        entityId: options.entityId,
        metadata: {
          ...(options.metadata || {}),
          mentionTokens: tokens
        }
      }))
    );

    const settled = await Promise.allSettled(requests);
    const sent = settled.filter(item => item.status === 'fulfilled').length;
    const failed = settled.length - sent;

    return {
      tokens,
      matched,
      sent,
      failed,
      unknown: [...unknown]
    };
  }

  private async loadMentionableUsers(force = false): Promise<MentionableUser[]> {
    const now = Date.now();
    const hasFreshCache =
      !force &&
      this.mentionableUsersCache.length > 0 &&
      (now - this.mentionableUsersCachedAt) < this.cacheMs;

    if (hasFreshCache) {
      return this.mentionableUsersCache;
    }

    const response = await firstValueFrom(this.notificationsApi.listMentionableUsers());
    const currentUser = this.auth.user();
    const selfId = String(currentUser?.id || '').trim().toLowerCase();
    const selfEmail = String(currentUser?.email || '').trim().toLowerCase();

    const list = (response.items || []).filter(user => {
      const id = String(user.id || '').trim().toLowerCase();
      const email = String(user.email || '').trim().toLowerCase();
      if (selfId && id && selfId === id) return false;
      if (selfEmail && email && selfEmail === email) return false;
      return true;
    });

    this.mentionableUsersCache = list;
    this.mentionableUsersCachedAt = now;
    return list;
  }

  private extractTokens(texts: Array<string | null | undefined>): string[] {
    const merged = texts
      .map(value => String(value || ''))
      .filter(value => !!value.trim())
      .join('\n');
    if (!merged) return [];

    const output: string[] = [];
    const seen = new Set<string>();

    const quotedPattern = /@"([^"\n]{2,80})"/g;
    let quotedMatch: RegExpExecArray | null;
    while ((quotedMatch = quotedPattern.exec(merged)) !== null) {
      const token = this.normalizeToken(quotedMatch[1]);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      output.push(token);
    }

    const pattern = /(^|[\s(])@([A-Za-z0-9._+-]+(?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(merged)) !== null) {
      const token = this.normalizeToken(match[2]);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      output.push(token);
    }

    return output;
  }

  private buildLookup(users: MentionableUser[]): Map<string, MentionableUser[]> {
    const lookup = new Map<string, MentionableUser[]>();
    for (const user of users) {
      const email = this.normalizeToken(user.email);
      const displayName = this.normalizeToken(user.displayName);

      this.addLookupKey(lookup, email, user);
      this.addLookupKey(lookup, this.emailLocalPart(email), user);
      this.addLookupKey(lookup, displayName, user);
      this.addLookupKey(lookup, this.compact(displayName), user);

      for (const part of displayName.split(/\s+/)) {
        const value = this.normalizeToken(part);
        if (value.length < 2) continue;
        this.addLookupKey(lookup, value, user);
        this.addLookupKey(lookup, this.compact(value), user);
      }
    }
    return lookup;
  }

  private resolveToken(token: string, lookup: Map<string, MentionableUser[]>): MentionableUser[] {
    const normalized = this.normalizeToken(token);
    if (!normalized) return [];

    const keys = [
      normalized,
      this.compact(normalized),
      this.emailLocalPart(normalized),
      this.compact(this.emailLocalPart(normalized))
    ].filter(Boolean);

    const matches = new Map<string, MentionableUser>();
    for (const key of keys) {
      const found = lookup.get(key);
      if (!found?.length) continue;
      for (const user of found) {
        matches.set(this.userKey(user), user);
      }
    }

    return Array.from(matches.values());
  }

  private addLookupKey(lookup: Map<string, MentionableUser[]>, key: string, user: MentionableUser): void {
    const normalized = this.normalizeToken(key);
    if (!normalized) return;
    const list = lookup.get(normalized) || [];
    if (!list.some(item => this.userKey(item) === this.userKey(user))) {
      list.push(user);
      lookup.set(normalized, list);
    }
  }

  private normalizeToken(value: unknown): string {
    return String(value || '')
      .trim()
      .replace(/^@+/, '')
      .replace(/[.,;:!?()[\]{}"']+$/g, '')
      .toLowerCase();
  }

  private compact(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  private emailLocalPart(value: string): string {
    const token = this.normalizeToken(value);
    const at = token.indexOf('@');
    if (at <= 0) return token;
    return token.slice(0, at);
  }

  private userKey(user: MentionableUser): string {
    return `${String(user.id || '').trim().toLowerCase()}::${String(user.email || '').trim().toLowerCase()}`;
  }
}
