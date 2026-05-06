import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';

export class UploaderService {
    /**
     * Uploads a file to GoFile and returns the download link.
     */
    static async uploadToGoFile(filePath: string): Promise<string> {
        try {
            // 1. Get best server
            const { data: serverData } = await axios.get('https://api.gofile.io/getServer');
            if (serverData.status !== 'ok') throw new Error('GoFile: Could not get server.');
            const server = serverData.data.server;

            // 2. Upload file
            const formData = new FormData();
            formData.append('file', fs.createReadStream(filePath));

            const { data: uploadData } = await axios.post(`https://${server}.gofile.io/uploadFile`, formData, {
                headers: {
                    ...formData.getHeaders(),
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            if (uploadData.status !== 'ok') throw new Error('GoFile: Upload failed.');

            return uploadData.data.downloadPage;
        } catch (err: any) {
            console.error('❌ UploaderService error:', err.message);
            throw err;
        }
    }
}
