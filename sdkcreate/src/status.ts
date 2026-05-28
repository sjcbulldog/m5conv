export interface StatusEntry {
    name: string;
    bsp: string;
    create_status: string;
    mtb2cmake_status: string;
    cmake_status: string;
    ninja_status: string;
}

import * as fs from 'fs';
import * as path from 'path';

export class StatusTracker {
    private file_: string;
    private entries_: StatusEntry[] = [];

    constructor(file: string) {
        this.file_ = file;
        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }

    public addEntry(entry: StatusEntry): void {
        const idx = this.entries_.findIndex(e => e.name === entry.name && e.bsp === entry.bsp);
        if (idx >= 0) {
            this.entries_[idx] = entry;
        } else {
            this.entries_.push(entry);
        }
        this.save();
    }

    public updateEntry(bsp: string, name: string, fields: Partial<StatusEntry>): void {
        const idx = this.entries_.findIndex(e => e.name === name && e.bsp === bsp);
        if (idx >= 0) {
            this.entries_[idx] = { ...this.entries_[idx], ...fields };
        } else {
            this.entries_.push({
                name,
                bsp,
                create_status: 'pending',
                mtb2cmake_status: 'pending',
                cmake_status: 'pending',
                ninja_status: 'pending',
                ...fields,
            });
        }
        this.save();
    }

    public getEntry(bsp: string, name: string): StatusEntry | undefined {
        return this.entries_.find(e => e.name === name && e.bsp === bsp);
    }

    public getAll(): StatusEntry[] {
        return this.entries_;
    }

    private save(): void {
        const maxRetry = 5;
        for (let i = 0; i < maxRetry; i++) {
            try {
                fs.writeFileSync(this.file_, JSON.stringify(this.entries_, null, 2) + '\n', 'utf-8');
                return;
            } catch {
                // brief pause before retry if file is locked
                const wait = Date.now() + 200;
                while (Date.now() < wait) { /* spin */ }
            }
        }
    }
}
