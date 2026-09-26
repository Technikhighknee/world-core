export class MinPriorityQueue {
    constructor() {
        this.heap = [];
    }

    get size() {
        return this.heap.length;
    }

    push(value, priority) {
        const entry = { value, priority };
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

    #bubbleUp(index) {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.heap[parent].priority <= this.heap[index].priority) break;

            [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
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
                this.heap[left].priority < this.heap[smallest].priority
            ) {
                smallest = left;
            }

            if (
                right < this.heap.length &&
                this.heap[right].priority < this.heap[smallest].priority
            ) {
                smallest = right;
            }

            if (smallest === index) break;

            [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
            index = smallest;
        }
    }
}
