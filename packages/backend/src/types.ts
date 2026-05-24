export type AppEnv = {
  Variables: {
    requestId: string
    currentUser: {
      userId: number
      email: string
      projectId: number | null
    }
    agent: {
      agentId: number
      projectId: number
      capabilities: Record<string, unknown>
    }
  }
}
