export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  cost: number;
}

export interface ModelClient {
  generate(messages: ModelMessage[]): Promise<ModelResponse>;
}

export class FakeModelClient implements ModelClient {
  private callCount = 0;

  async generate(messages: ModelMessage[]): Promise<ModelResponse> {
    this.callCount++;

    const lastMessage = messages[messages.length - 1];
    const content = lastMessage?.content || "";

    let response = "";

    if (content.includes("plan") || content.includes("break down")) {
      response = JSON.stringify({
        tasks: [
          { id: "task-1", goal: "Implement core functionality" },
          { id: "task-2", goal: "Add tests" },
          { id: "task-3", goal: "Update documentation" },
        ],
      });
    } else if (content.includes("verify") || content.includes("check")) {
      response = JSON.stringify({
        verified: true,
        issues: [],
      });
    } else if (content.includes("judge") || content.includes("evaluate")) {
      response = JSON.stringify({
        passed: true,
        score: 0.85,
        feedback: "Implementation looks good",
      });
    } else {
      response = `Fake model response #${this.callCount}`;
    }

    const promptTokens = messages.reduce((sum, m) => sum + m.content.length / 4, 0);
    const completionTokens = response.length / 4;

    return {
      content: response,
      usage: {
        promptTokens: Math.ceil(promptTokens),
        completionTokens: Math.ceil(completionTokens),
        totalTokens: Math.ceil(promptTokens + completionTokens),
      },
      cost: (promptTokens * 0.00001 + completionTokens * 0.00003),
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
  }
}
