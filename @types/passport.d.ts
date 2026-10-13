declare global {
    namespace Express {
        interface User {
            credentialVersion?: number
            email: string
            id: string
            username: string
        }
    }
}
export { }
