--!strict
--- One mutant: the code to find in a file, what to put in its place, and the rule that breaks.

export type Mutant = { file: string, from: string, to: string, breaks: string }

return nil
