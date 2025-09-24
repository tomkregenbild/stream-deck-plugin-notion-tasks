export interface NotionDatabaseResponse {
  properties: Record<string, {
    name: string;
    type: string;
    status?: {
      options: Array<{ name: string }>;
    };
    select?: {
      options: Array<{ name: string }>;
    };
  }>;
}

export interface NotionViewResponse {
  properties: Record<string, {
    visible: boolean;
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

  async fetchViewProperties(databaseId: string, viewId: string, token: string): Promise<Record<string, { type: string; visible: boolean }>> {
    // First, get the database to understand property types
    const dbResponse = await this.fetchDatabaseProperties(databaseId, token);
    
    // Then get the view to understand which properties are visible
    const viewResponse = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      method: "GET",
      headers: this.buildHeaders(token),
    });

    if (viewResponse.status === 429) {
      const retryAfter = Number(viewResponse.headers.get("Retry-After")) || 1;
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return this.fetchViewProperties(databaseId, viewId, token);
    }

    if (!viewResponse.ok) {
      throw new Error(`Failed to fetch view properties: ${viewResponse.status}`);
    }

    const viewData = await viewResponse.json() as any;
    
    // Build a combined response with property types and visibility
    const result: Record<string, { type: string; visible: boolean }> = {};
    
    // For now, we'll assume all database properties are visible in the view
    // since Notion's API doesn't directly expose view-specific visibility
    // In a real implementation, you'd need to use the specific view API endpoints
    for (const [propName, propData] of Object.entries(dbResponse.properties)) {
      result[propName] = {
        type: (propData as any).type,
        visible: true // Default to visible - this could be enhanced with actual view data
      };
    }
    
    return result;
  }
}