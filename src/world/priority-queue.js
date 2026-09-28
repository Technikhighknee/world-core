export class MinPriorityQueue {
    constructor() {
        this.heap = [];
        this.sequence = 0;
    }

    get size() {
        return this.heap.length;
    }

    push(value, priority, tieBreaker = String(value)) {
        const entry = {
            value,
            priority,
            tieBreaker,
            sequence: this.sequence++,
        };

        this.heap.push(entry);
        this.#bubbleUp(this.heap.length - 1);
    }

    pop() {
        if (this.heap.length === 0) return null;

        const first = this.heap[0];
        const last = this.heap.pop();

        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.#bubbleDown(0);
        }

        return first;
    }

    #compare(a, b) {
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }

        if (a.tieBreaker < b.tieBreaker) return -1;
        if (a.tieBreaker > b.tieBreaker) return 1;

        return a.sequence - b.sequence;
    }

    #bubbleUp(index) {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);

            if (
                this.#compare(
                    this.heap[parent],
                    this.heap[index],
                ) <= 0
            ) {
                break;
            }

            [this.heap[parent], this.heap[index]] = [
                this.heap[index],
                this.heap[parent],
            ];

            index = parent;
        }
    }

    #bubbleDown(index) {
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;

            if (
                left < this.heap.length &&
                this.#compare(
                    this.heap[left],
                    this.heap[smallest],
                ) < 0
            ) {
                smallest = left;
            }

            if (
                right < this.heap.length &&
                this.#compare(
                    this.heap[right],
                    this.heap[smallest],
                ) < 0
            ) {
                smallest = right;
            }

            if (smallest === index) break;

            [this.heap[index], this.heap[smallest]] = [
                this.heap[smallest],
                this.heap[index],
            ];

            index = smallest;
        }
    }
}
