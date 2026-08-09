declare global {
    namespace Express {
        interface User {
            email: string
            id: string
            username: string
        }
    }
}
export { }
