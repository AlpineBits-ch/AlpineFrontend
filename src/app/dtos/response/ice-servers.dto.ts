export interface IceServersDto {
    iceServers: IceServerDto[];
}

export interface IceServerDto {
    urls: string[];
    username: string;
    credential: string;
}