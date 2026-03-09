import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, of } from 'rxjs';

export type AddressSuggestion = {
  id: string;
  display: string;
};

@Injectable({ providedIn: 'root' })
export class AddressLookupService {
  private readonly http = inject(HttpClient);

  search(query: string, limit = 6, countryCodes = 'us'): Observable<AddressSuggestion[]> {
    const trimmed = String(query || '').trim();
    if (trimmed.length < 4) return of([]);

    const params = new URLSearchParams();
    params.set('format', 'jsonv2');
    params.set('addressdetails', '1');
    params.set('limit', String(Math.max(1, Math.min(10, Number(limit) || 6))));
    params.set('countrycodes', String(countryCodes || 'us'));
    params.set('q', trimmed);

    return this.http.get<any[]>(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: {
        'Accept-Language': 'en-US'
      }
    }).pipe(
      map(items => {
        const list = Array.isArray(items) ? items : [];
        return list.map(item => {
          const addr = item?.address || {};
          const line1 = [addr.house_number, addr.road].filter(Boolean).join(' ').trim();
          const city = [addr.city, addr.town, addr.village, addr.hamlet].find(Boolean);
          const line2 = [city, addr.state, addr.postcode].filter(Boolean).join(', ').trim();
          const display = [line1, line2].filter(Boolean).join(', ').trim() || String(item?.display_name || '').trim();
          const id = String(item?.place_id || `${display}-${item?.lat || ''}-${item?.lon || ''}`);
          return { id, display } as AddressSuggestion;
        }).filter(item => !!item.display);
      })
    );
  }
}
