export interface NotionDatabaseResponse {
  properties: Record<string, {
    name: string;
    type: string;
    status?: {
      options: Array<{ name: string }>;
    };
  }>;
}

export class NotionClient {
  private buildHeaders(token?: string) {
    return {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };
  }

  async fetchDatabaseProperties(db: string, token: string): Promise<NotionDatabaseResponse> {
    const response = await fetch(`https://api.notion.com/v1/databases/${db}`, {
      method: "GET",
      headers: this.buildHeaders(token),
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After")) || 1;
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return this.fetchDatabaseProperties(db, token);
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch database properties: ${response.status}`);
    }

    return await response.json() as NotionDatabaseResponse;
  }
}