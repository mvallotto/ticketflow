export type Event = {
    id: string;
    title: string;
    description: string;
    location: string;
    startsAt: string;
    createdAt: string;
  };

  export type TicketType = {
    id: string;
    eventId: string;
    name: string;
    priceCents: number;
    capacity: number;
    reservedQuantity: number;
    soldQuantity: number;
    availableQuantity: number;
  };
  
  export type EventDetail = Event & {
    ticketTypes: TicketType[];
  };
