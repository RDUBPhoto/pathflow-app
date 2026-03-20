import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CustomersApi } from './customers-api.service';

describe('CustomersApi', () => {
  let service: CustomersApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CustomersApi,
        provideHttpClient(),
        provideHttpClientTesting()
      ]
    });

    service = TestBed.inject(CustomersApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('creates a lead through upsert', () => {
    let result: any = null;

    service.upsert({
      name: 'QA Lead',
      email: 'qa.lead@example.com',
      phone: '(555) 010-2020'
    }).subscribe(res => {
      result = res;
    });

    const req = httpMock.expectOne('/api/customers');
    expect(req.request.method).toBe('POST');
    expect(req.request.body.name).toBe('QA Lead');
    req.flush({ ok: true, id: 'cust-qa-1' });

    expect(result?.ok).toBeTrue();
    expect(result?.id).toBe('cust-qa-1');
  });

  it('maps list response from value array', () => {
    let resultLength = 0;

    service.list().subscribe(items => {
      resultLength = items.length;
    });

    const req = httpMock.expectOne('/api/customers');
    expect(req.request.method).toBe('GET');
    req.flush({ value: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] });

    expect(resultLength).toBe(2);
  });
});
