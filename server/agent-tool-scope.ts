/** Server-owned tool capability boundary; never deserialize this from HTTP. */
export interface AgentToolScope {
  instructions: string
  images?:readonly {mimeType:'image/png'|'image/jpeg';dataBase64:string;label:string}[]
  definitions: readonly { name: string; description: string; parameters: Record<string, unknown> }[]
  execute(name: string, input: unknown): Promise<unknown>
}
