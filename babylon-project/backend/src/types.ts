import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface Clock {
  now(): Date;
}

export interface RandomSource {
  token(bytes?: number): string;
  uuid(): string;
}

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface Database {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface ReturnProfile {
  clientId: string;
  uri: string;
  development: boolean;
}
